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
import re
import secrets
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config
from . import store
from .bridge import BridgeController
from .contradiction import ContradictionEngine
from .degradation import Degradation
from .deltas import DeltaHub, encode
from .extraction import (
    TurnWindow,
    compact,
    entity_aliases,
    extract,
    redaction_count,
)
from .proxy import ProxyActionLayer
from .rti import ParticipantFrame, RTIMonitor
from . import voice_agent
from .ledger import Ledger
from .privacy import PrivacyGate
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
from .utterance import (
    EpistemicViolation,
    close_out,
    contradiction_intervention,
    joined,
    tension_intervention,
)

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
rti = RTIMonitor()
proxy = ProxyActionLayer(channel="inc-4417")
degraded = Degradation()
# §10.5 — whether the bridge is currently being minuted at all. Sits in front
# of redaction, not behind it: redaction decides what a vendor sees, this
# decides whether an utterance is processed.
privacy = PrivacyGate()

# In-flight background analyses. Held strongly because asyncio keeps only a
# weak reference to a running task — dropping ours would let the garbage
# collector cancel an extraction halfway through, silently.
_pipeline_tasks: set[asyncio.Task[Any]] = set()
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

    # ── DURABILITY, AND WHY IT IS OPTIONAL ──────────────────────────────
    # `connect` never raises: a machine with no Docker must still run the
    # bridge, degrading to the in-memory Ledger it has always used. Whether
    # persistence is actually on is reported by /health rather than assumed.
    if await store.connect():
        try:
            restored = await ledger.restore()
            if restored:
                log.info("Ledger restored from Postgres: %d rows", restored)
        except Exception:
            log.exception("could not restore the Ledger — continuing empty")

    ticker = asyncio.create_task(flush_ticker())
    log.info("Slow Loop up. observer mode=%s", config.observer_mode())

    yield

    ticker.cancel()
    await store.close()
    await _http.aclose()


app = FastAPI(title="EchoSphere — Slow Loop", version="0.1.0", lifespan=lifespan)

# The dashboard is served from :3000 in development, but the console may run on
# any port (e.g. :3001 when something else owns 3000). CORS_ORIGINS lets a host
# override the dev defaults without editing source; the browser must be allowed
# to POST /observer/transcript or the voice path dies silently.
_cors_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    *[
        o.strip()
        for o in config.cors_origins().split(",")
        if o.strip()
    ],
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# The tunnel gate
# ---------------------------------------------------------------------------
#
# Agora's Engine calls our REST tools from its own servers, so the Slow Loop
# must be publicly reachable for `query_incident_state` to work. A tunnel does
# that — and in doing so exposes `/incident/reset`, `/bridge/say` and
# `/approval/redeem` to anyone who learns the hostname.
#
# So anything arriving on a non-local Host must present AGENT_TOOL_SECRET.
# Local traffic is untouched: the dashboard, the demo script and all three
# Rehearsal Rig tiers behave exactly as they did before this existed.
#
# Fail-closed on purpose. If the tunnel is up and the secret is NOT set, every
# remote request is refused rather than served — the alternative is a public,
# unauthenticated control surface that looks like it is working.

def _is_local(host: str) -> bool:
    return host.split(":")[0].strip("[]").lower() in ("127.0.0.1", "localhost", "::1")


@app.middleware("http")
async def tunnel_gate(request: Request, call_next):  # type: ignore[no-untyped-def]
    host = request.headers.get("host", "")
    if _is_local(host):
        return await call_next(request)

    # Health is the one thing a tunnel may answer unauthenticated: it reports
    # presence, never values, and being able to check "is the tunnel live?"
    # without a token is worth more than hiding it.
    if request.url.path in ("/health", "/"):
        return await call_next(request)

    # ── CORS PREFLIGHTS CANNOT CARRY THE TOKEN ─────────────────────────────
    #
    # A browser sends OPTIONS *before* the real request and is forbidden from
    # attaching custom headers to it, so `x-echo-tool-token` is never present.
    # Refusing it 401 kills the request that follows, and the browser reports
    # only "Failed to fetch" — which surfaced here as
    # "Transcript forwarding paused: Failed to fetch", naming neither CORS nor
    # this gate.
    #
    # Answering the preflight grants nothing: it returns headers, never data,
    # and the POST behind it is still gated below.
    if request.method == "OPTIONS":
        return await call_next(request)

    # ── THE CONSOLE'S OWN BROWSER PATHS ────────────────────────────────────
    #
    # This gate was written for ONE remote caller: Agora's servers invoking
    # /tools/*. Sharing the console over a tunnel added a second, which the
    # gate had never seen — the guest's BROWSER, which holds no secret and
    # must never be given one (it would be readable by anyone with the link).
    #
    # These two are what a participating browser needs, and neither is a
    # control surface: /observer/transcript ingests speech the sender just
    # spoke aloud on the bridge, and /ws/deltas is the same read-only view the
    # dashboard already renders.
    #
    # Everything that CHANGES the world — /incident/reset, /bridge/say,
    # /approval/redeem, /tools/* — stays behind the token. That is the line
    # this gate exists to hold, and it still holds.
    if request.url.path in ("/observer/transcript", "/ws/deltas"):
        return await call_next(request)

    secret = config.tool_secret()
    if not secret:
        log.warning("refused remote %s %s — AGENT_TOOL_SECRET is not set", request.method, host)
        return JSONResponse(
            {"error": "This service is not configured to accept remote requests."},
            status_code=503,
        )

    presented = request.headers.get("x-echo-tool-token", "")
    if not secrets.compare_digest(presented, secret):
        log.warning("refused remote %s %s — bad or missing tool token", request.method, host)
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    return await call_next(request)


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
            # Surfaced, never assumed: a silent fallback to an in-memory
            # Ledger is exactly the kind of quiet degradation this project
            # keeps having to hunt down after the fact.
            "persistence": store.status(),
            "degraded": degraded.to_wire(),
            "agent": _agent,
            "seq": hub.seq,
            "subscribers": hub.subscriber_count,
            # Whether analysis is still in flight.
            #
            # Exposed because "the claim count stopped changing" is NOT the
            # same as "the pipeline finished" — under rate-limit backoff it
            # sits still for seconds mid-window, and a harness that treats a
            # pause as completion reports lost claims that are merely late.
            # This is the authoritative answer: tasks running, frames waiting.
            "pipeline": {
                "inFlight": len(_pipeline_tasks),
                "windowFrames": len(window.frames),
            },
        },
        status_code=200 if ready else 503,
    )


# ---------------------------------------------------------------------------
# Agent creation — the SDK path (see app/voice_agent.py)
# ---------------------------------------------------------------------------

def _with_recap(prompt: str) -> str:
    """
    Append the Ledger recap to a system prompt, when there is one.

    A replacement agent starts with an empty history, so without this the
    person who joins third can ask what has been established and be told
    nothing, while the dashboard beside them shows a full Ledger.
    """
    try:
        recap = ledger.recap()
    except Exception:
        log.warning("could not build the ledger recap", exc_info=True)
        return prompt
    if not recap:
        return prompt

    header = (
        "[WHAT THIS BRIDGE HAS ALREADY ESTABLISHED]\n"
        "You are joining an incident already in progress. What follows is"
        " the record so far, attributed. Treat it as the record, not as"
        " your own recollection, and keep attributing it when you refer"
        " to it.\n\n"
    )
    return prompt + "\n\n" + header + recap

@app.post("/agent/start")
async def start_agent(body: dict[str, Any]) -> JSONResponse:
    """
    Create the Agora agent through the official SDK, then register it here.

    ── WHY ZONE 2 NO LONGER BUILDS THE PAYLOAD ────────────────────────────
    It built it by hand, and Agora returns 200 for a payload it only partly
    understands. Every misplaced field failed silently, and the failure that
    survived longest was the one that matters most: the recogniser never ran,
    so `content` came back EMPTY for turns carrying seconds of real speech.

    The SDK derives the vendor presets instead of asserting them, and refuses
    to construct an invalid recogniser at all. See `voice_agent.py`.

    This endpoint deliberately also does the REGISTER step, because the two
    were previously separate calls from Zone 2 and a lost second call left
    Echo mute for the session with no way back. One call, one outcome.
    """
    channel = (body.get("channel") or "").strip()
    prompt = body.get("systemPrompt") or ""
    if not channel or not prompt:
        return JSONResponse(
            {"error": "channel and systemPrompt are required"}, status_code=400,
        )

    try:
        result = await voice_agent.start(
            channel=channel,
            agent_uid=int(body.get("agentUid") or 0),
            user_uid=int(body.get("userUid") or 0),
            # Everyone else already on the bridge, so Echo can hear the whole
            # room rather than only the console that invited it.
            other_uids=[int(u) for u in (body.get("otherUids") or []) if int(u) > 0],
            # ── HAND A REPLACEMENT AGENT THE INCIDENT SO FAR ───────────────
            # Adding a speaker means a NEW agent (remote_rtc_uids is fixed at
            # creation), and a new agent starts with an empty history. Without
            # this, whoever joins third can ask "what have we established?"
            # and be told nothing — while the dashboard beside them shows a
            # full Ledger.
            #
            # The recap is attributed and non-diagnostic by construction, and
            # INFERRED claims are excluded, so nothing enters the prompt that
            # the model could mistake for its own knowledge.
            system_prompt=_with_recap(prompt),
            tts=body.get("tts") or {},
            greeting=body.get("greeting"),
            llm_mode=(body.get("llmMode") or "managed"),
            groq_api_key=body.get("groqApiKey"),
            groq_model=body.get("groqModel"),
            tools=body.get("tools"),
        )
    except voice_agent.VoiceAgentError as exc:
        # Degradation (§13): a failed invite must not take the dashboard with
        # it. Reported, not raised.
        log.warning("agent start failed: %s", exc)
        return JSONResponse(
            {"error": str(exc), "degraded": True}, status_code=502,
        )

    agent_id = result["agent_id"]
    already_known = _agent["agent_id"] == agent_id
    _agent["agent_id"] = agent_id
    _agent["channel"] = channel
    log.info("agent started and registered: %s on %s", agent_id, channel)

    greeting = None
    if not already_known and bool(body.get("greet", True)):
        try:
            line = joined(can_read_ledger=bool(body.get("tools")))
            # `async with`, matching /agent/register: the context manager owns
            # the HTTP client the controller speaks through. And `speak`, not
            # `speak_now` — there is nothing to interrupt on a fresh join.
            async with BridgeController(channel, agent_id, client=_http) as br:
                result = await br.speak(line, priority="high", force=True)
            greeting = {"spoken": bool(result and result.ok), "text": line}
        except Exception as exc:
            # A hoarse TTS vendor must not fail the whole invite.
            log.warning("greeting failed", exc_info=True)
            greeting = {"spoken": False, "error": str(exc)}

    return JSONResponse({
        "ok": True,
        "agentId": agent_id,
        "channel": channel,
        "agent": _agent,
        "greeting": greeting,
    })


@app.post("/agent/stop")
async def stop_agent_endpoint(body: dict[str, Any]) -> dict[str, Any]:
    """Stop the agent through the SDK and forget it here."""
    agent_id = (body.get("agentId") or _agent["agent_id"] or "").strip()
    if not agent_id:
        return {"ok": False, "reason": "no agent registered"}
    try:
        await voice_agent.stop(agent_id)
    except voice_agent.VoiceAgentError as exc:
        log.warning("agent stop failed: %s", exc)
        return {"ok": False, "reason": str(exc)}
    _agent["agent_id"] = None
    _agent["channel"] = None
    return {"ok": True, "stopped": agent_id}


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

    # Is this the same agent we already knew about?
    #
    # Re-registration is EXPECTED, not an error. Zone 2's invite is idempotent
    # per channel, so a second console joining - or the same person rejoining
    # after a reload - reuses the agent and registers it again. It has to:
    # this process holds the agent id in memory, so a backend restart forgets
    # it, and without a re-register Echo stays mute forever with no way back
    # short of a new channel.
    #
    # What must NOT repeat is the greeting. Echo announcing itself on every
    # reload is the "filler" the prompt forbids, and on a live bridge it reads
    # as a stuck agent.
    already_known = _agent["agent_id"] == agent_id

    _agent["agent_id"] = agent_id
    _agent["channel"] = channel
    log.info(
        "agent %s: %s on %s",
        "re-registered" if already_known else "registered", agent_id, channel,
    )

    # Zone 2 decides whether this arrival deserves an announcement, because
    # only Zone 2 knows whether it just CREATED the agent or is re-registering
    # one that already existed. This process cannot tell: it holds the agent id
    # in memory, so after a restart every agent looks new to it, and Echo would
    # re-introduce itself to a room it has been sitting in for twenty minutes.
    wants_greeting = bool(body.get("greet", True))

    if already_known or not wants_greeting:
        reason = "already registered" if already_known else "not a new session"
        return {"ok": True, "agent": _agent, "greeting": {"spoken": False, "reason": reason}}

    # ── PROOF OF LIFE ──────────────────────────────────────────────────────
    # Echo used to join in complete silence. From inside the room that is
    # indistinguishable from a broken agent, a wrong channel, a failed invite
    # or a mute TTS vendor — all four of which have happened here, and none of
    # which announce themselves. One spoken line separates them instantly.
    #
    # Composed by `utterance.joined` rather than Agora's `greeting_message`
    # so it passes the same §6 gate as every other sentence Echo speaks; the
    # model never gets to write the first thing anyone hears.
    #
    # Best-effort: a greeting that fails must not fail the registration, or a
    # hoarse TTS vendor would take the whole bridge down with it.
    greeting = None
    try:
        line = joined(can_read_ledger=bool(body.get("toolsEnabled")))
        async with BridgeController(channel, agent_id, client=_http) as br:
            # `speak`, NOT `speak_now`. speak_now interrupts first, and a
            # greeting has nothing to pre-empt - it is the first thing said.
            # The interrupt raced its own utterance and Agora recorded the
            # arrival line truncated to the single word "Echo".
            result = await br.speak(line, priority="high", force=True)
        greeting = {"spoken": bool(result and result.ok), "text": line}
    except Exception as exc:  # noqa: BLE001 — never block registration
        log.warning("greeting failed (agent is registered regardless): %s", exc)
        greeting = {"spoken": False, "error": str(exc)}

    return {"ok": True, "agent": _agent, "greeting": greeting}


@app.post("/agent/unregister")
async def unregister_agent(body: dict[str, Any]) -> dict[str, Any]:
    """
    Forget the agent — the other half of `/agent/register`.

    Without this, stopping an agent left the Bridge Controller holding a dead
    id: `/speak` would be issued against an agent that had left the channel,
    fail, and raise the degradation banner for a reason nobody could see. The
    pre-flight caught it as "leftover agent from a previous run" that no reset
    could clear, because only a backend restart cleared it.

    Scoped by channel so a stop on one bridge cannot silence another.
    """
    channel = (body.get("channel") or "").strip()
    if channel and _agent["channel"] not in (None, channel):
        return {"ok": False, "reason": "different channel", "agent": _agent}

    was = _agent["agent_id"]
    _agent["agent_id"] = None
    _agent["channel"] = None
    log.info("agent unregistered: %s", was or "(none)")
    return {"ok": True, "was": was}


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
        try:
            result = await extract(text, compact(ledger), aliases=entity_aliases(ledger))
        except Exception:  # noqa: BLE001 — see below; never lose an utterance
            """
            PUT THE WINDOW BACK.

            `drain()` empties the window before extraction runs, so an
            extraction that raised used to take those frames with it — the
            words were spoken, and then simply were not in the record. Groq's
            per-minute limit is per organisation, so a busy moment on the
            bridge is exactly when this fires: the analysis matters most and
            the claims vanish quietest.

            That is not an acceptable failure for an evidence ledger. The
            frames go back and the flush ticker retries them a second later,
            by which time the per-minute budget has usually recovered.

            `window.add` dedupes on message id, so a frame that partially
            succeeded cannot be counted twice.
            """
            log.exception(
                "pipeline: extraction failed on %d frame(s) — requeued", len(frames),
            )
            for frame in frames:
                window.requeue(frame)
            return None

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
                aliases=[str(a) for a in (r.get("aliases") or [])],
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

        """
        ONE INTERRUPTION PER WINDOW - BUT THE RIGHT ONE.

        This loop used to break on the first claim that produced ANY actionable
        verdict. §5.1's single-slot queue says speak once per window, and that
        is correct; what was wrong was letting arrival order decide WHICH.

        Seen in validation: Act 1's "carts empty" and "latency is through the
        roof" adjudicated INDEPENDENT - true, they are different properties -
        and the loop stopped there. The pair the whole demo turns on, "the
        cache is fine" against "cache read timeouts", was never reached.

        OPPOSED short-circuits, since nothing outranks two claims that cannot
        both be true. Anything else is held while the remaining claims are
        checked. The extra evaluations land only when the first hit was the
        weaker kind, and `ContradictionEngine.evaluate` still enforces its own
        panel budget underneath, so the 429 ceiling is unchanged.
        """
        held: tuple[Claim, Claim, Any] | None = None

        for claim in new_claims:
            found = await engine.evaluate(claim, existing)
            if not found:
                continue

            other, verdict = found
            if verdict.relation == "OPPOSED":
                held = (claim, other, verdict)
                break
            if held is None:
                held = (claim, other, verdict)

        if held is not None:
            claim, other, verdict = held
            spoken = await _surface_contradiction(claim, other, verdict)

        return {"claims": len(new_claims), "delta": bool(delta), "spoken": spoken}


async def _surface_contradiction(a: Claim, b: Claim, verdict: Any) -> dict[str, Any] | None:
    """Record the conflict, then speak it — Rule 3 filtered, §6 validated."""
    if len(BridgeController.strip_inferred([a, b])) < 2:
        return None

    relation = verdict.relation
    # A PanelVerdict carries the deliberation; the legacy Adjudication does not.
    panel = verdict.as_dict() if hasattr(verdict, "positions") else None

    cx = Contradiction(id=f"cx-{now_ms()}", claim_a=a.id, claim_b=b.id,
                       speakers=[a.speaker_role, b.speaker_role], relation=relation,
                       why=getattr(verdict, "why", None) or None, panel=panel)
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

    # §13: losing the Bridge must NOT lose the finding. The contradiction is
    # already on the dashboard by this point — all that is lost is Echo saying
    # it aloud, and the banner makes that explicit rather than leaving the room
    # wondering why it went quiet.
    if result is None or not result.ok:
        if degraded.voice_failed("bridge /speak failed"):
            await hub.publish({"degraded": degraded.to_wire()})
    elif degraded.voice_restored():
        await hub.publish({"degraded": degraded.to_wire()})

    return {"spoken": bool(result and result.ok), "text": line}


@app.get("/health/model")
async def model_health(request: Request) -> dict[str, Any]:
    """
    Is there any analysis budget left today?

    ── WHY THIS IS AN ENDPOINT AND NOT A DOC NOTE ──────────────────────────
    Groq's free tier is 200,000 tokens per DAY, scoped per model. A full demo
    costs 15–20k, so roughly ten runs — and a day of tuning eats all of it.
    When it goes, nothing announces it. The console still joins, the dashboard
    still fills with transcripts, Echo still sits in the channel. The claims
    simply never appear, because every extraction is failing behind the
    scenes with a 429 nobody is looking at.

    That is the worst possible failure to discover with an audience watching,
    and it is invisible right up until the moment it matters. So the
    pre-flight asks, using a deliberately tiny probe (a handful of tokens),
    and refuses to say GO when the answer is no.
    ────────────────────────────────────────────────────────────────────────
    """
    from .extraction import groq_json

    # Probes the model chain as a whole. `groq_json` rotates keys internally,
    # so "available" here means "reachable on at least one key" — which is the
    # question a pre-flight actually needs answered.
    keys = len(config.groq_api_keys())

    """
    PRIMARY ONLY, unless asked for everything.

    Probing all three models serially means three calls, each with its own
    rate-limit retries — which under load takes minutes and timed the
    pre-flight out, reporting "could not probe the model — is the Slow Loop
    up?" while the Slow Loop was plainly up and answering.

    The question a pre-flight actually asks is "can we run a demo now", and
    the primary model answers it: the fallbacks only matter once it is gone,
    and `groq_json` reaches them on its own. `?all=1` still probes the chain
    when the fuller picture is wanted.
    """
    probe_all = request.query_params.get("all") in ("1", "true", "yes")
    chain = config.analysis_models()
    models_to_probe = chain if probe_all else chain[:1]

    results: list[dict[str, Any]] = []
    for model in models_to_probe:
        try:
            # The word "json" must appear literally in the messages — Groq
            # rejects `response_format: json_object` without it, with a 400.
            # The first version of this probe said 'Reply with {"ok":true}'
            # and failed every single time, which the pre-flight then reported
            # as an exhausted quota. A check that cries wolf is worse than no
            # check: it trains you to ignore the one time it is right.
            await groq_json(
                "Reply with the JSON object {\"ok\":true} and nothing else.",
                "Return that json now.",
                # ── THE SAME MISTAKE AS PANEL_MAX_TOKENS, MADE TWICE ────────
                # 64 looks obviously generous for `{"ok":true}` and is wrong.
                # These are REASONING models: they emit reasoning tokens before
                # the JSON, so a tight ceiling truncates them mid-thought and
                # Groq returns
                #
                #     400 json_validate_failed, failed_generation: ''
                #
                # which this endpoint then reported as the model being
                # unavailable. The pre-flight spent a day insisting two healthy
                # models were exhausted, and a check that cries wolf is worse
                # than no check — it trains you to ignore the one time it is
                # right. Matches PANEL_MAX_TOKENS for the same reason.
                max_tokens=1536,
                models=[model],
            )
            results.append({"model": model, "available": True})
        except Exception as exc:  # noqa: BLE001 — the SDK raises several shapes
            message = str(exc)
            low = message.lower()

            # The distinction is the whole point of the field: a per-MINUTE
            # limit clears while you are still setting up, a per-DAY one means
            # there is no demo today. Telling an operator "rate limited" for
            # both is useless at exactly the moment they need to decide.
            if "per day" in low or "tpd" in low:
                reason = "DAILY quota exhausted — resets tomorrow"
            elif "per minute" in low or "tpm" in low:
                reason = "per-minute limit — clears in under a minute"
            elif "429" in message or "rate_limit" in low:
                reason = "rate limited"
            else:
                # NOT a quota problem. Saying "rate limited" here sent an
                # operator hunting for a budget they had not spent.
                reason = "request rejected — see detail"

            wait = re.search(r"try again in ([\dhms.]+)", message)
            used = re.search(r"Used (\d+)", message)
            limit = re.search(r"Limit (\d+)", message)

            # The raw text, truncated. Classifying vendor error strings is
            # guesswork — Groq has at least TPM, TPD and RPM shapes and they
            # change — so the parsed fields are a convenience and THIS is the
            # ground truth. An operator deciding whether to wait or reschedule
            # deserves to see what the vendor actually said.
            log.warning("model probe: %s unavailable — %s", model, message)

            results.append({
                "model": model,
                "available": False,
                "reason": reason,
                "retryAfter": wait.group(1) if wait else None,
                "used": int(used.group(1)) if used else None,
                "limit": int(limit.group(1)) if limit else None,
                "detail": message[-300:],
            })

    usable = [r for r in results if r["available"]]
    return {
        "usable": len(usable),
        "primary": results[0]["model"] if results else None,
        # Surfaced so the pre-flight can say "budget is tight" honestly: with
        # two keys a single exhausted model is far less alarming than with one.
        "keys": keys,
        "models": results,
    }


@app.get("/privacy/inventory")
async def privacy_inventory() -> dict[str, Any]:
    """
    Exactly what Echo is holding about this bridge — §10.5.

    Exists because "we redact PII" is an assurance, and an assurance is not
    evidence. Anyone can read this and see the real counts, where they live,
    and when they die. It answers "what are you keeping about me" with
    numbers instead of a paragraph.
    """
    snap = ledger.snapshot()
    return privacy.inventory(
        claims=len(snap.get("claims", [])),
        entities=len(snap.get("entities", [])),
        transcripts=len(snap.get("transcripts", [])),
        redactions=redaction_count(),
    )


@app.post("/privacy/recording")
async def set_recording(body: dict[str, Any]) -> dict[str, Any]:
    """
    The same control as the spoken phrase, for the console.

    Speech is the primary control (§10.5 rule 1) — nobody alt-tabs mid-Sev-1.
    This is the fallback for a participant with no microphone, and for
    stopping a recording you only realised was running after the fact.
    """
    want = bool(body.get("recording", True))
    role = (body.get("role") or "Console").strip() or "Console"

    phrase = "back on the record" if want else "off the record"
    decision = privacy.evaluate(phrase, role)

    if decision.action in ("pause", "resume"):
        event = ledger.add_timeline(TimelineEvent(
            id=f"tl-{now_ms()}", kind="decision",
            text=(f"{role} brought the bridge BACK ON THE RECORD" if want
                  else f"{role} took the bridge OFF THE RECORD — Echo stopped minuting"),
            actor=role,
        ))
        await hub.publish({
            "timeline": [event.to_wire()],
            "privacy": privacy.state.to_wire(),
        })

    return {"recording": privacy.state.recording,
            "suspendedTurns": privacy.state.suspended_turns}


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

    # §10.4 says transcripts and derived state are PURGED, not retained, so
    # the durable copy goes with the in-memory one. `global` has to come
    # first: Python binds the declaration for the whole function body, so
    # reading `ledger.channel` above it is a SyntaxError, not a warning.
    channel = ledger.channel
    await store.clear(channel)
    ledger = Ledger(channel=channel)

    # The window and the cooldown table are incident state too. Leaving frames
    # in the window would let the previous run's last sentence be extracted into
    # the new incident, and a stale cooldown would silence a genuine conflict.
    window.drain()
    engine._cooldown.clear()  # noqa: SLF001 — same-module reset seam
    rti.reset()
    global proxy, degraded, privacy
    proxy = ProxyActionLayer(channel=proxy.channel)
    degraded = Degradation()
    # A new incident starts ON the record. Carrying a pause across a reset
    # would mean the next incident silently records nothing, which is the one
    # failure mode of this feature that nobody would notice until afterwards.
    privacy = PrivacyGate()

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

    # ── §10.5 CONSENT GATE — before redaction, before extraction, before the
    # transcript is published to a single dashboard.
    #
    # Position is the entire feature. Redaction decides what a VENDOR sees;
    # this decides whether the utterance is processed at all. A suspended turn
    # must not be handled more carefully — it must not be handled.
    decision = privacy.evaluate(text, role)

    if decision.action == "drop":
        # Counted, never stored. `text` is not logged, not published, not kept.
        return {"ignored": "off the record", "recording": False}

    if decision.action in ("pause", "resume"):
        # The control phrase itself is minuted in both directions: "Priya took
        # the bridge off the record at 14:32" is what an incident review needs,
        # and it reveals nothing about what was then said in private.
        event = ledger.add_timeline(TimelineEvent(
            id=f"tl-{now_ms()}",
            kind="decision",
            text=(
                f"{role} took the bridge OFF THE RECORD — Echo stopped minuting"
                if decision.action == "pause"
                else f"{role} brought the bridge BACK ON THE RECORD"
            ),
            actor=role,
        ))
        await hub.publish({
            "timeline": [event.to_wire()],
            "privacy": privacy.state.to_wire(),
        })
        # Echo says it out loud, because a recording state the room cannot
        # perceive is worse than none at all.
        #
        # Wrapped, and the reason is a real 500: the §6 tripwire refused
        # "Recording resumed." for naming no source, the exception escaped the
        # handler, and the whole ingest endpoint returned a non-JSON error.
        # The phrase is allowed now — but a guard that can crash the path
        # carrying every utterance is the wrong shape regardless of which
        # phrases currently pass it. Losing the announcement costs a spoken
        # confirmation; losing the endpoint costs the incident record.
        spoke = False
        try:
            br = await _bridge()
            if br is not None and decision.announce:
                async with br:
                    result = await br.speak_now(decision.announce)
                    spoke = bool(result and result.ok)
        except EpistemicViolation as exc:
            log.error("privacy: refused to speak a §6-violating line: %s", exc)
        except Exception:  # noqa: BLE001 — see above; never break ingestion
            log.exception("privacy: could not announce the recording change")

        return {"accepted": True, "recording": privacy.state.recording,
                "announced": decision.announce, "spoken": spoke}

    t = Transcript(
        message_id=body.get("messageId") or f"m-{now_ms()}",
        uid=uid,
        role=role,
        text=text,
        is_final=bool(body.get("isFinal", True)),
        at=int(body.get("at") or now_ms()),
    )

    # Extraction batches on turn boundaries (§4.4). Only final frames enter the
    # window; the flush ticker handles the silence rule. `add` also rejects a
    # repeat of an utterance already accepted.
    accepted = window.add(t)

    # The raw record beneath the claims. "What exactly was said" is where
    # every disputed claim ends up, and extraction is not reversible.
    if accepted:
        store.save(t, ledger.channel)

    # A duplicate is not re-published either. The reducer would dedupe it by
    # messageId, but a delta that changes nothing still costs a render on every
    # connected dashboard — and a transcript appearing twice in the feed while
    # someone is reading it is its own small betrayal of trust.
    if accepted or not t.is_final:
        # The transcript reaches the dashboard immediately — an operator should
        # see words appear as they are spoken, not 1.5 s later when the window
        # flushes.
        await hub.publish({"transcripts": [t.to_wire()]})
    else:
        return {"accepted": False, "duplicate": True, "messageId": t.message_id}

    """
    THE PIPELINE RUNS IN THE BACKGROUND, and this is not an optimisation.

    Awaiting it here made the response time of `/observer/transcript` equal to
    the runtime of the whole analysis: extraction, entity resolution, and up to
    two Deliberation Panels, each of which honours Groq's rate-limit backoff by
    sleeping. A rehearsal on Aug 31 hit a 60-second ReadTimeout on a single
    utterance because of it.

    The caller is a BROWSER forwarding speech as it is spoken. Blocking it for
    a minute stalls every subsequent utterance behind the slow one, so a busy
    moment on the bridge — exactly when the analysis matters most — is exactly
    when transcripts stop arriving.

    Nothing is lost by returning early. The transcript has already been
    published above, and every result the pipeline produces reaches the
    dashboard over the delta socket, which is the asynchronous channel §9.3
    exists to provide. `run_pipeline_if_ready` takes a lock, so overlapping
    tasks are safe.
    """
    task = asyncio.create_task(run_pipeline_if_ready())
    # Held until completion: asyncio keeps only a weak reference to a running
    # task, and a garbage-collected one cancels the analysis mid-flight.
    _pipeline_tasks.add(task)
    task.add_done_callback(_pipeline_tasks.discard)

    def _report(t: asyncio.Task[Any]) -> None:
        if not t.cancelled() and t.exception() is not None:
            log.exception("pipeline failed in the background", exc_info=t.exception())

    task.add_done_callback(_report)

    return {
        "accepted": True,
        "messageId": t.message_id,
        # The analysis is now in flight rather than finished. Named so no
        # caller mistakes a fast 200 for a completed extraction.
        "queued": True,
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


# ---------------------------------------------------------------------------
# Proxy Action Layer + Authorization Gate — v6 §4.5, §10.2
# ---------------------------------------------------------------------------

@app.post("/tools/invoke")
async def invoke_tool(body: dict[str, Any]) -> dict[str, Any]:
    """
    Every tool call Echo makes lands here, whatever asked for it.

    Classification is a property of the ACTION, never of the request, so a
    prompt injection that talks Echo into execute_runbook_script still meets
    the Authorization Gate (§14.4).
    """
    action = (body.get("action") or "").strip()
    args = body.get("args") or {}
    if not action:
        return {"error": "action is required"}

    result = proxy.invoke(
        action, args, task=body.get("task", ""), evidence=body.get("evidence"),
    )

    if result.status == "PENDING_APPROVAL" and result.approval:
        # The dashboard raises the modal. It shows the full arguments AND the
        # evidence chain, so a human approves against the record rather than
        # against Echo's summary of it.
        await hub.broadcast({
            "kind": "APPROVAL_REQUEST",
            "at": now_ms(),
            "approval": {
                **result.approval,
                "evidence": [
                    c.to_wire() for c in (
                        ledger.claims.get(cid) for cid in (body.get("evidence") or [])
                    ) if c
                ],
            },
        })

        # Echo says the sentence that makes the constraint audible.
        br = await _bridge()
        if br is not None:
            line = (
                f"DevOps, I have prepared {action.replace('_', ' ')}. "
                "It is a critical action — it needs your approval on the dashboard. "
                "I cannot authorise it from voice alone."
            )
            async with br:
                await br.speak(line, priority="high")

    return {
        "status": result.status,
        "action": result.action,
        "tier": result.tier,
        "detail": result.detail,
        "ref": result.ref,
        "approval": result.approval,
    }


@app.post("/approval/verbal")
async def verbal_intent(body: dict[str, Any]) -> dict[str, Any]:
    """
    A human said "yes, approved" out loud.

    This endpoint exists to make the security claim legible: it logs, and it
    authorizes nothing. There is no path from here to a redemption.
    """
    proxy.gate.record_verbal_intent(
        int(body.get("uid", 0)), str(body.get("phrase", "")),
    )
    event = ledger.add_timeline(TimelineEvent(
        id=f"tl-{now_ms()}", kind="signal",
        text="Verbal assent logged as intent. Awaiting dashboard approval.",
        actor="Echo",
    ))
    await hub.publish({"timeline": [event.to_wire()]})
    return {"logged": True, "authorized": False}


@app.post("/approval/redeem")
async def redeem_approval(body: dict[str, Any]) -> dict[str, Any]:
    """A click in the dashboard, from an authenticated session."""
    uid = int(body.get("uid", 0))
    role = str(body.get("role", ""))
    entry = await get_entry_for(uid)

    result = proxy.redeem(
        str(body.get("nonce", "")), uid, role,
        # Authority comes from the ROSTER, not from what the browser claims.
        authorized=bool(entry and entry.get("authorized")),
        args=body.get("args"),
        evidence=body.get("evidence"),
    )

    if result.status == "PENDING_APPROVAL":
        task = ledger.upsert_task(Task(
            id=f"task-{now_ms()}", assignee_role=role,
            description=f"{result.action} — filed as {result.ref}",
            status="DONE", evidence=body.get("evidence") or [], ref=result.ref,
        ))
        event = ledger.add_timeline(TimelineEvent(
            id=f"tl-{now_ms()}", kind="decision",
            text=f"{result.action} approved on dashboard by {role} (UID {uid}).",
            actor=role,
        ))
        await hub.publish({"tasks": [task.to_wire()], "timeline": [event.to_wire()]})

        br = await _bridge()
        if br is not None:
            async with br:
                await br.speak(
                    f"Filed as {result.ref}, approved by {role}. "
                    "No infrastructure was changed by me — a human executes it.",
                    priority="high",
                )

    return {"status": result.status, "detail": result.detail, "ref": result.ref}


@app.post("/approval/deny")
async def deny_approval(body: dict[str, Any]) -> dict[str, Any]:
    """
    A human said no. §W5: acknowledge once, do not re-ask.

    The approval is marked redeemed, so 'do not re-ask' is structural — there
    is no token left to redeem even if Echo tried.
    """
    result = proxy.deny(str(body.get("nonce", "")), int(body.get("uid", 0)))
    return {"status": result.status, "detail": result.detail}


@app.get("/audit")
async def audit_trail() -> dict[str, Any]:
    """
    §10.3 — governance evidence, replay input, and post-mortem source.

    Records denials and failed redemptions as loudly as successes: a log
    containing only successes is evidence of nothing.
    """
    return {"entries": proxy.audit, "filed": proxy.filed}


async def get_entry_for(uid: int) -> dict[str, Any] | None:
    """
    Roster lookup for the redeeming session.

    Zone 2 owns the Roster today, so this trusts the uid range until the
    Python Roster lands (S2). Recorded rather than hidden: this is the weakest
    link in the gate right now, and it is the next thing to harden.
    """
    if uid == 1001:
        return {"uid": uid, "role": "DevOps Lead", "authorized": True}
    return {"uid": uid, "role": "unknown", "authorized": False}


# ---------------------------------------------------------------------------
# RTI — v6 §8
# ---------------------------------------------------------------------------

@app.post("/rti/observe")
async def rti_observe(body: dict[str, Any]) -> dict[str, Any]:
    """
    One slice of per-participant audio metrics from the Observer.

    The metrics fork sits UPSTREAM of STT (§4.3): tension is a property of HOW
    people are speaking, not what they said, so it never blocks on
    transcription.
    """
    frames = [
        ParticipantFrame(
            uid=int(f.get("uid", 0)), rms=float(f.get("rms", 0.0)),
            f0=float(f["f0"]) if f.get("f0") else None,
            speaking=bool(f.get("speaking")),
        )
        for f in body.get("frames", [])
    ]
    now = time.monotonic()
    value = rti.observe(frames, now)

    await hub.publish({"rti": round(value, 3)})

    spoken = None
    if rti.should_intervene(now):
        established = BridgeController.strip_inferred(ledger.established())
        if established:
            try:
                line = tension_intervention(
                    established, next(iter(ledger.open_unchecked()), None)
                )
            except (EpistemicViolation, ValueError):
                line = None

            if line:
                rti.mark_intervened(now)
                br = await _bridge()
                if br is not None:
                    async with br:
                        # NORMAL priority: a de-escalation that interrupts
                        # someone mid-sentence ADDS tension (§W6).
                        result = await br.speak(line, priority="normal")
                        spoken = bool(result and result.ok)

    return {"rti": round(value, 3), "state": rti.state, "spoke": spoken}


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
