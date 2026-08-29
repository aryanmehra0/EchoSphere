"""
Zone 3 — the Slow Loop service.

Wires the Ledger, the Delta Hub and the Bridge Controller behind a small HTTP
and WebSocket surface. Nothing here speaks unless `utterance.py` composed the
sentence and `bridge.py` let it through.

Run:  .venv/Scripts/uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config
from .bridge import BridgeController
from .contradiction import ContradictionEngine
from .deltas import DeltaHub, encode
from .extraction import TurnWindow, compact, entity_aliases, extract
from .ledger import Ledger
from .models import (
    Claim,
    Contradiction,
    Entity,
    Link,
    Task,
    TimelineEvent,
    Transcript,
    Unchecked,
    now_ms,
)
from .utterance import EpistemicViolation, close_out, contradiction_intervention

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)-14s %(message)s")
log = logging.getLogger("echo.main")

ledger = Ledger()
hub = DeltaHub()

# The live agent, registered by the frontend after /api/invite-agent succeeds.
# Kept as state rather than config because it changes every session.
_agent: dict[str, str | None] = {"agent_id": None, "channel": None}
_http: httpx.AsyncClient | None = None


window = TurnWindow()
engine = ContradictionEngine()
_pipeline_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http
    _http = httpx.AsyncClient(timeout=20.0)

    # The silence-based flush needs a ticker: the 1.5 s rule fires when someone
    # STOPS talking, and no incoming frame will arrive to trigger it. Without
    # this, the last sentence before a pause sits in the window unextracted —
    # which on a bridge is precisely the sentence people are waiting on.
    async def flush_ticker() -> None:
        while True:
            await asyncio.sleep(0.5)
            try:
                await run_pipeline_if_ready()
            except Exception:  # noqa: BLE001 — a bad window must not kill the loop
                log.exception("flush ticker failed")

    ticker = asyncio.create_task(flush_ticker())
    log.info("Slow Loop up. observer mode=%s", config.observer_mode())

    yield

    ticker.cancel()
    await _http.aclose()


app = FastAPI(title="EchoSphere — Slow Loop", version="0.1.0", lifespan=lifespan)

# The dashboard is served from :3000 in development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> JSONResponse:
    creds = config.credential_status()
    missing = [k for k, present in creds.items() if not present]
    ready = not missing
    return JSONResponse(
        {
            "ready": ready,
            "credentials": creds,
            "missing": missing,
            "observerMode": config.observer_mode(),
            "agent": _agent,
            "seq": hub.seq,
            "subscribers": hub.subscriber_count,
        },
        status_code=200 if ready else 503,
    )


# ---------------------------------------------------------------------------
# Agent registration — the frontend tells us which agent to drive
# ---------------------------------------------------------------------------

@app.post("/agent/register")
async def register_agent(body: dict[str, Any]) -> dict[str, Any]:
    """
    Called after Zone 2's /api/invite-agent succeeds.

    The Bridge cannot speak without an agent id, and only Zone 2 knows it —
    it holds the Agora credentials that created the agent.
    """
    agent_id = (body.get("agentId") or "").strip()
    channel = (body.get("channel") or "").strip()
    if not agent_id or not channel:
        return {"error": "agentId and channel are required"}

    _agent["agent_id"] = agent_id
    _agent["channel"] = channel
    log.info("agent registered: %s on %s", agent_id, channel)
    return {"ok": True, "agent": _agent}


# ---------------------------------------------------------------------------
# Observer ingress — the adapter seam (v6 §4.3)
# ---------------------------------------------------------------------------

async def run_pipeline_if_ready() -> dict[str, Any] | None:
    """
    W2 then W3 — the core ingestion path and the headline workflow.

        window -> redact -> extract -> validate -> Ledger -> deltas
                                                      |
                                                      +-> contradiction -> Bridge

    Guarded by a lock because both the flush ticker and an incoming frame can
    reach here: extracting the same window twice would double every claim.
    """
    async with _pipeline_lock:
        if not window.should_flush():
            return None

        frames = window.drain()
        if not frames:
            return None

        text = "\n".join(f"[{f.role}] {f.text}" for f in frames)
        log.info("pipeline: extracting a %d-frame window", len(frames))

        # Carry the Ledger's alias table so entity ids stay stable across
        # windows — "Redis" in window 3 must resolve to the id it got in
        # window 1, or contradiction scoping silently finds nothing.
        result = await extract(text, compact(ledger), aliases=entity_aliases(ledger))

        # -- merge ---------------------------------------------------------
        delta: dict[str, Any] = {}

        def _merge(key: str, rows: list[dict[str, Any]], build, upsert) -> None:
            made = []
            for row in rows:
                try:
                    obj = build(row)
                except (KeyError, TypeError, ValueError) as exc:
                    # One malformed row must not cost the whole window.
                    log.warning("pipeline: skipped a %s row: %s", key, exc)
                    continue
                upsert(obj)
                made.append(obj.to_wire())
            if made:
                delta[key] = made

        # Entity de-duplication.
        #
        # The model re-proposes the same real-world thing under a fresh id every
        # window ("e2" then "cache" for Redis). Creating both gives four graph
        # nodes for two systems AND splits the claims between them, which is
        # what silently disabled contradiction detection. Map a duplicate label
        # onto the id that already exists instead.
        known_aliases = entity_aliases(ledger)

        def _entity(r: dict[str, Any]) -> Entity:
            proposed = str(r["id"]).strip()
            label = str(r.get("label", proposed)).strip()
            canonical = known_aliases.get(label.lower()) or known_aliases.get(proposed.lower())
            return Entity(
                id=canonical or proposed,
                label=label or proposed,
                kind=r.get("kind", "service"),
                status=r.get("status", "UNKNOWN"),
                detail=r.get("detail"),
                metric=r.get("metric"),
            )

        _merge("entities", result["entities"], _entity, ledger.upsert_entity)

        _merge("links", result["links"],
               lambda r: Link(id=r["id"], source=r["source"], target=r["target"],
                              label=r.get("label", ""), kind=r.get("kind", "suspected")),
               ledger.upsert_link)

        new_claims: list[Claim] = []

        def _claim_upsert(c: Claim) -> None:
            ledger.upsert_claim(c)
            new_claims.append(c)

        _merge("claims", result["claims"],
               lambda r: Claim(id=r["id"], text=r["text"], entity=r.get("entity"),
                               epistemic_status=r["epistemicStatus"],
                               speaker_role=r["speakerRole"],
                               confidence=float(r.get("confidence", 0.8))),
               _claim_upsert)

        _merge("unchecked", result["unchecked"],
               lambda r: Unchecked(id=r["id"], description=r["description"],
                                   suggested_owner=r.get("suggestedOwner")),
               ledger.upsert_unchecked)

        _merge("tasks", result["tasks"],
               lambda r: Task(id=r["id"], assignee_role=r["assigneeRole"],
                              description=r["description"], status=r.get("status", "OPEN"),
                              evidence=r.get("evidence") or []),
               ledger.upsert_task)

        _merge("timeline", result["timeline"],
               lambda r: TimelineEvent(id=r["id"], kind=r.get("kind", "signal"),
                                       text=r["text"], actor=r.get("actor", "Echo")),
               ledger.add_timeline)

        if delta:
            envelope = await hub.publish(delta)
            log.info("pipeline: published seq=%s", envelope.get("seq"))

        # -- W3: does anything now conflict? -------------------------------
        spoken = None
        existing = list(ledger.claims.values())
        for claim in new_claims:
            found = await engine.evaluate(claim, existing)
            if not found:
                continue

            other, verdict = found
            spoken = await _surface_contradiction(claim, other, verdict.relation)
            break  # one interruption per window; §5.1's single-slot queue

        return {"claims": len(new_claims), "delta": bool(delta), "spoken": spoken}


async def _surface_contradiction(a: Claim, b: Claim, relation: str) -> dict[str, Any] | None:
    """Record the conflict, then speak it — Rule 3 filtered, §6 validated."""
    if len(BridgeController.strip_inferred([a, b])) < 2:
        return None

    cx = Contradiction(id=f"cx-{now_ms()}", claim_a=a.id, claim_b=b.id,
                       speakers=[a.speaker_role, b.speaker_role], relation=relation)
    ledger.upsert_contradiction(cx)
    event = ledger.add_timeline(TimelineEvent(
        id=f"tl-{now_ms()}", kind="contradiction",
        text="Two observations are in tension. Echo intervening.", actor="Echo",
    ))
    await hub.publish({"contradictions": [cx.to_wire()], "timeline": [event.to_wire()]})

    gap = next(iter(ledger.open_unchecked()), None)
    try:
        line = contradiction_intervention(a, b, relation=relation, gap=gap)
    except EpistemicViolation as exc:
        log.error("pipeline: refused to speak a §6-violating line: %s", exc)
        return None

    br = await _bridge()
    if br is None:
        return {"spoken": False, "text": line, "reason": "no agent registered"}

    async with br:
        result = await br.speak_now(line)
    return {"spoken": bool(result and result.ok), "text": line}


@app.post("/incident/reset")
async def reset_incident() -> dict[str, Any]:
    """
    Clear the Ledger and start a fresh incident.

    Needed because the Ledger is a live in-process object: a second run inherits
    the first one's claims, its contradictions, and — most visibly — its
    `phase: resolved`. A dashboard that opens on a resolved incident nobody has
    had yet is exactly the sort of thing that derails a rehearsal.

    S6 asks for three clean runs back to back (§17). This is what makes that
    possible without restarting the process.

    Also satisfies §10.4: transcripts and derived state are session-scoped and
    purged, not retained.
    """
    global ledger
    ledger = Ledger()

    # The window and the cooldown table are incident state too. Leaving frames
    # in the window would let the previous run's last sentence be extracted into
    # the new incident, and a stale cooldown would silence a genuine conflict.
    window.drain()
    engine._cooldown.clear()  # noqa: SLF001 — same-module reset seam

    # Tell every connected dashboard to drop what it is holding. The reducer's
    # SNAPSHOT case replaces rather than merges, so this genuinely clears them
    # rather than leaving orphans behind.
    reached = await hub.broadcast({
        "seq": hub.seq,
        "at": now_ms(),
        "kind": "SNAPSHOT",
        "state": ledger.snapshot(),
    })

    log.info("incident reset — ledger cleared, %d dashboards resynced", reached)
    return {"ok": True, "phase": ledger.phase, "dashboards": reached}


@app.post("/observer/transcript")
async def ingest_transcript(body: dict[str, Any]) -> dict[str, Any]:
    """
    One role-attributed utterance enters the Slow Loop here.

    ── WHY THIS IS AN HTTP ENDPOINT ────────────────────────────────────────
    v6 §4.3 has the Observer pulling per-UID PCM straight off the SD-RTN via
    `on_playback_audio_frame_before_mixing`, which needs the Agora Python
    Server SDK. That SDK has no wheel for Python 3.14 — the only interpreter
    available — and fails to build from source.

    So the Observer is a pluggable ADAPTER and this is its seam. Whatever
    produces role-attributed text calls this endpoint; everything downstream is
    identical. That also makes Rehearsal Rig Tier 2 (§15) trivial, since
    synthetic transcripts drive the exact same path as live audio.

    The agent-UID exclusion that closes G2 lives here too: Echo's own speech
    must never re-enter the Ledger as if a human said it.
    ────────────────────────────────────────────────────────────────────────
    """
    uid = int(body.get("uid", 0))
    role = (body.get("role") or "").strip()
    text = (body.get("text") or "").strip()

    if not text:
        return {"ignored": "empty text"}

    # G2 — the first branch, before anything is allocated. Echo's own audio is
    # discarded at the earliest possible point.
    if uid in (9000, 9001) or role.lower() == "echo":
        log.info("observer: dropped uid %s (agent exclusion, G2)", uid)
        return {"ignored": "agent audio", "uid": uid}

    if not role:
        # An unattributable participant is an error worth logging, not a
        # routine case to guess at (§4.2's ordering rule makes this rare).
        log.warning("observer: uid %s has no role — claim would be unsourced", uid)
        return {"ignored": "unattributed uid", "uid": uid}

    t = Transcript(
        message_id=body.get("messageId") or f"m-{now_ms()}",
        uid=uid,
        role=role,
        text=text,
        is_final=bool(body.get("isFinal", True)),
        at=int(body.get("at") or now_ms()),
    )

    # The transcript reaches the dashboard immediately — an operator should see
    # words appear as they are spoken, not 1.5 s later when the window flushes.
    await hub.publish({"transcripts": [t.to_wire()]})

    # Extraction batches on turn boundaries (§4.4). Only final frames enter the
    # window; the flush ticker handles the silence rule.
    window.add(t)
    outcome = await run_pipeline_if_ready()

    return {
        "accepted": True,
        "messageId": t.message_id,
        "extracted": outcome,
    }


# ---------------------------------------------------------------------------
# Ledger writes
# ---------------------------------------------------------------------------

@app.post("/ledger/claim")
async def add_claim(body: dict[str, Any]) -> dict[str, Any]:
    """
    Record a claim. `speakerRole` is mandatory — Claim raises without it, which
    is §6.2 Rule 1 enforced at the point of ingestion where it can still be
    repaired.
    """
    try:
        claim = Claim(
            id=body["id"],
            text=body["text"],
            epistemic_status=body.get("epistemicStatus", "OBSERVED"),
            speaker_role=body.get("speakerRole", ""),
            confidence=float(body.get("confidence", 0.9)),
            entity=body.get("entity"),
            supersedes=body.get("supersedes"),
            contradicts=body.get("contradicts") or [],
        )
    except (KeyError, ValueError) as exc:
        return {"error": str(exc)}

    ledger.upsert_claim(claim)
    await hub.publish({"claims": [claim.to_wire()]})
    return {"ok": True, "claim": claim.to_wire()}


@app.post("/ledger/unchecked")
async def add_unchecked(body: dict[str, Any]) -> dict[str, Any]:
    """Requirement 5's quiet half — what nobody has established."""
    item = Unchecked(
        id=body["id"],
        description=body["description"],
        suggested_owner=body.get("suggestedOwner"),
    )
    ledger.upsert_unchecked(item)
    await hub.publish({"unchecked": [item.to_wire()]})
    return {"ok": True}


# ---------------------------------------------------------------------------
# The Fast Loop's read channel — v6 §5.2, closes G1
# ---------------------------------------------------------------------------

@app.post("/tools/query_incident_state")
async def query_incident_state(body: dict[str, Any]) -> dict[str, Any]:
    """
    The tool webhook Echo calls for ANY factual question.

    Deterministic read with no LLM in the path — which is what makes "ask eight
    times, get eight identical answers" a structural property rather than a
    hope about model stability (§5.2).
    """
    scope = body.get("scope") or (body.get("arguments") or {}).get("scope") or "summary"
    entity = body.get("entity") or (body.get("arguments") or {}).get("entity")
    return ledger.query(scope, entity)


# ---------------------------------------------------------------------------
# The Bridge — Echo's proactive voice
# ---------------------------------------------------------------------------

async def _bridge() -> BridgeController | None:
    if not _agent["agent_id"] or not _agent["channel"]:
        return None
    return BridgeController(_agent["channel"], _agent["agent_id"], client=_http)


@app.post("/bridge/contradiction")
async def bridge_contradiction(body: dict[str, Any]) -> dict[str, Any]:
    """
    W3 — the headline workflow.

    Composes the intervention from the two claims, filters INFERRED (Rule 3),
    validates against Rules 1–2, records it, then speaks it.
    """
    a = ledger.claims.get(body.get("claimA", ""))
    b = ledger.claims.get(body.get("claimB", ""))
    if not a or not b:
        return {"error": "both claimA and claimB must exist in the ledger"}

    # Rule 3: an inferred claim may never reach the voice channel.
    speakable = BridgeController.strip_inferred([a, b])
    if len(speakable) < 2:
        return {"error": "an INFERRED claim cannot be spoken (§6.2 Rule 3)"}

    gap = next(iter(ledger.open_unchecked()), None)

    try:
        line = contradiction_intervention(
            a, b, relation=body.get("relation", "INDEPENDENT"), gap=gap
        )
    except EpistemicViolation as exc:
        return {"error": f"composition violated §6: {exc}"}

    cx = Contradiction(
        id=body.get("id") or f"cx-{now_ms()}",
        claim_a=a.id,
        claim_b=b.id,
        speakers=[a.speaker_role, b.speaker_role],
        relation=body.get("relation"),
    )
    ledger.upsert_contradiction(cx)
    ledger.add_timeline(TimelineEvent(
        id=f"tl-{now_ms()}",
        kind="contradiction",
        text="Two observations are in tension. Echo intervening.",
        actor="Echo",
    ))
    await hub.publish({
        "contradictions": [cx.to_wire()],
        "timeline": [ledger.timeline[-1].to_wire()],
    })

    br = await _bridge()
    if br is None:
        return {"spoken": False, "reason": "no agent registered", "text": line}

    async with br:
        result = await br.speak_now(line)

    return {
        "spoken": bool(result and result.ok),
        "text": line,
        "latencyMs": result.latency_ms if result else None,
    }


@app.post("/bridge/close-out")
async def bridge_close_out(body: dict[str, Any]) -> dict[str, Any]:
    """
    W9 — the moment the architecture pays off.

    States what was established and by whom, what remains unresolved, and then
    says plainly that root cause is not established.
    """
    minutes = int(body.get("minutes") or max(1, (now_ms() - ledger.started_at) // 60000))
    try:
        line = close_out(
            BridgeController.strip_inferred(ledger.established()),
            ledger.open_hypotheses(),
            ledger.open_unchecked(),
            minutes=minutes,
            timeline_count=len(ledger.timeline),
        )
    except (EpistemicViolation, ValueError) as exc:
        return {"error": str(exc)}

    ledger.phase = "resolved"
    await hub.publish({"phase": "resolved"})

    br = await _bridge()
    if br is None:
        return {"spoken": False, "reason": "no agent registered", "text": line}

    async with br:
        result = await br.speak_now(line)

    return {"spoken": bool(result and result.ok), "text": line}


@app.post("/bridge/say")
async def bridge_say(body: dict[str, Any]) -> dict[str, Any]:
    """
    Escape hatch for rehearsal and S0. Still validated against §6 — there is no
    path through this service that can emit a diagnosing sentence.
    """
    br = await _bridge()
    if br is None:
        return {"error": "no agent registered — POST /agent/register first"}

    try:
        async with br:
            result = await br.speak(body.get("text", ""), force=bool(body.get("force")))
    except EpistemicViolation as exc:
        return {"error": str(exc)}

    if result is None:
        return {"spoken": False, "reason": "suppressed by the interruption floor"}
    return {"spoken": result.ok, "status": result.status, "latencyMs": result.latency_ms}


@app.post("/bridge/interrupt")
async def bridge_interrupt() -> dict[str, Any]:
    br = await _bridge()
    if br is None:
        return {"error": "no agent registered"}
    async with br:
        return {"ok": await br.interrupt()}


# ---------------------------------------------------------------------------
# Dashboard socket — v6 §9.3, closes G6
# ---------------------------------------------------------------------------

@app.websocket("/ws/deltas")
async def deltas_socket(ws: WebSocket) -> None:
    """
    HELLO / SNAPSHOT / REPLAY.

    The client sends `{"kind":"HELLO","lastSeq":n|null}`. A fresh client gets a
    SNAPSHOT; a reconnecting one gets a REPLAY when its gap is still in the ring
    buffer, and a SNAPSHOT when it is not. The reducer merges by id and is
    idempotent, so replayed deltas are always safe to reapply.
    """
    await ws.accept()
    queue = hub.subscribe()

    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10.0)
        last_seq = hello.get("lastSeq")
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        last_seq = None

    if last_seq is None:
        await ws.send_text(encode({
            "kind": "SNAPSHOT", "seq": hub.seq, "state": ledger.snapshot(),
        }))
    else:
        replay = hub.since(int(last_seq))
        if replay is None:
            await ws.send_text(encode({
                "kind": "SNAPSHOT", "seq": hub.seq, "state": ledger.snapshot(),
            }))
        else:
            for envelope in replay:
                await ws.send_text(encode({**envelope, "kind": "REPLAY"}))

    try:
        while True:
            envelope = await queue.get()
            await ws.send_text(encode(envelope))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.unsubscribe(queue)
