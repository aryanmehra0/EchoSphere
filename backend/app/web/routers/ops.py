"""
Operations — readiness, budget, consent inventory, and the incident reset.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from app.application.services import budget
from app.application.services.extraction import redaction_count
from app.application.services.session import registry
from app.domain.models import TimelineEvent, now_ms
from app.domain.policies.postmortem import generate_markdown_report, generate_postmortem
from app.infrastructure import config, store
from ..deps import session

log = logging.getLogger("echo.ops")

router = APIRouter()


@router.get("/health")
async def health() -> JSONResponse:
    current = session()

    creds = config.credential_status()

    # `GROQ_API_KEY` is INFORMATIONAL, not required. Readiness asks
    # "is an analysis LLM configured", which `ANALYSIS_LLM` answers for any
    # provider — so a Gemma-only bridge is ready, while the Groq row stays in
    # the payload for the tooling that reads it by name.
    #
    # Reported as missing regardless, because an operator who expected Groq to
    # be wired up should still see that it is not.
    missing = [k for k, present in creds.items() if not present]
    required = [k for k in missing if k != "GROQ_API_KEY"]
    ready = not required
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
            "degraded": current.degraded.to_wire(),
            "agent": current.agent,
            "seq": current.hub.seq,
            "subscribers": current.hub.subscriber_count,
            # Whether analysis is still in flight.
            #
            # Exposed because "the claim count stopped changing" is NOT the
            # same as "the pipeline finished" — under rate-limit backoff it
            # sits still for seconds mid-window, and a harness that treats a
            # pause as completion reports lost claims that are merely late.
            # This is the authoritative answer: tasks running, frames waiting.
            #
            # `total_in_flight`, not `current.in_flight`: a task spawned just
            # before an `/incident/reset` runs on the retired session, and a
            # harness polling this must still see it. Reporting only the
            # current session made Tier 3 sample early on run 2 of 3.
            "pipeline": {
                "inFlight": registry.total_in_flight,
                "windowFrames": len(current.window.frames),
            },
        },
        status_code=200 if ready else 503,
    )


@router.get("/health/model")
async def model_health(request: Request) -> dict[str, Any]:
    """
    Is there any analysis budget left today?

    The logic lives in `services/budget.py` — classifying a vendor's
    rate-limit strings deserves its own tests, and a per-DAY exhaustion means
    something operationally different from a per-MINUTE one.
    """
    probe_all = request.query_params.get("all") in ("1", "true", "yes")
    return await budget.probe(probe_all=probe_all)


@router.get("/privacy/inventory")
async def privacy_inventory() -> dict[str, Any]:
    """
    Exactly what Echo is holding about this bridge — §10.5.

    Exists because "we redact PII" is an assurance, and an assurance is not
    evidence. Anyone can read this and see the real counts, where they live,
    and when they die. It answers "what are you keeping about me" with
    numbers instead of a paragraph.
    """
    current = session()
    snap = current.ledger.snapshot()
    return current.privacy.inventory(
        claims=len(snap.get("claims", [])),
        entities=len(snap.get("entities", [])),
        transcripts=len(snap.get("transcripts", [])),
        redactions=redaction_count(),
    )


@router.post("/privacy/recording")
async def set_recording(body: dict[str, Any]) -> dict[str, Any]:
    """
    The same control as the spoken phrase, for the console.

    Speech is the primary control (§10.5 rule 1) — nobody alt-tabs mid-Sev-1.
    This is the fallback for a participant with no microphone, and for
    stopping a recording you only realised was running after the fact.
    """
    current = session()
    privacy = current.privacy

    want = bool(body.get("recording", True))
    role = (body.get("role") or "Console").strip() or "Console"

    phrase = "back on the record" if want else "off the record"
    decision = privacy.evaluate(phrase, role)

    if decision.action in ("pause", "resume"):
        event = current.ledger.add_timeline(TimelineEvent(
            id=f"tl-{now_ms()}", kind="decision",
            text=(f"{role} brought the bridge BACK ON THE RECORD" if want
                  else f"{role} took the bridge OFF THE RECORD — Echo stopped minuting"),
            actor=role,
        ))
        await current.hub.publish({
            "timeline": [event.to_wire()],
            "privacy": privacy.state.to_wire(),
        })

    return {"recording": privacy.state.recording,
            "suspendedTurns": privacy.state.suspended_turns}


@router.post("/incident/reset")
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
    old = session()
    channel = old.channel

    # §10.4 says transcripts and derived state are PURGED, not retained, so
    # the durable copy goes with the in-memory one.
    await store.clear(channel)

    # One call replaces the Ledger, the window, the cooldown table, the proxy,
    # the degradation state and the consent gate. Previously five module
    # globals were rebound by hand here and the engine's cooldown was cleared
    # through a private attribute — a field added to the incident later would
    # simply have been missed.
    fresh = registry.reset()

    # ── THE DASHBOARDS ARE SUBSCRIBED TO THE *OLD* HUB ─────────────────────
    #
    # A new session builds a new DeltaHub, and the browsers currently connected
    # hold queues from the previous one. Broadcasting the clearing SNAPSHOT on
    # `fresh.hub` would reach nobody: every open dashboard would keep showing
    # the finished incident until someone pressed reload.
    #
    # So the announcement goes out on the hub the clients are actually holding,
    # carrying the NEW session's (empty) state. The reducer's SNAPSHOT case
    # replaces rather than merges, so this genuinely clears them rather than
    # leaving orphans behind.
    reached = await old.hub.broadcast({
        "seq": old.hub.seq,
        "at": now_ms(),
        "kind": "SNAPSHOT",
        "state": fresh.ledger.snapshot(),
    })

    # Hand the live subscribers over, so a dashboard that never disconnects
    # keeps receiving deltas from the new session instead of going silent.
    fresh.hub.adopt(old.hub)

    log.info("incident reset — ledger cleared, %d dashboards resynced", reached)
    return {"ok": True, "phase": fresh.ledger.phase, "dashboards": reached}


@router.get("/incident/postmortem")
async def incident_postmortem() -> dict[str, Any]:
    """
    Automated Sev-1 Incident Post-Mortem & SOC2 Audit Generator.
    Returns structured JSON data and formatted GFM markdown.
    """
    current = session()
    snap = current.ledger.snapshot()
    privacy_inv = current.privacy.inventory(
        claims=len(snap.get("claims", [])),
        entities=len(snap.get("entities", [])),
        transcripts=len(snap.get("transcripts", [])),
        redactions=redaction_count(),
    )
    audit_entries = getattr(current.proxy, "audit", [])
    report = generate_postmortem(
        current.ledger,
        audit_entries=audit_entries,
        privacy_inventory=privacy_inv,
    )
    markdown = generate_markdown_report(report)
    return {"postmortem": report, "markdown": markdown}


@router.get("/incident/postmortem/markdown", response_class=PlainTextResponse)
async def incident_postmortem_markdown() -> PlainTextResponse:
    """Returns downloadable / printable GFM markdown."""
    data = await incident_postmortem()
    return PlainTextResponse(data["markdown"], media_type="text/markdown; charset=utf-8")

