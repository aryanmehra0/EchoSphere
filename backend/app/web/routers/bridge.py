"""
The Bridge — Echo's proactive voice.

Every route here goes through `SpeechCoordinator`, so the §6 gate and the
degradation bookkeeping apply identically no matter which one was called.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from app.domain.models import now_ms
from app.domain.policies.utterance import EpistemicViolation, close_out
from app.infrastructure.agora_bridge import BridgeController
from ..deps import session, speech

log = logging.getLogger("echo.bridge.routes")

router = APIRouter(prefix="/bridge")


@router.post("/roster")
async def bridge_roster(body: dict[str, Any]) -> dict[str, Any]:
    """
    Record one participant's role for this bridge, as decided by Zone 2.

    Called server-side by `/api/token` right after it mints a token — never
    directly by a browser. Zone 2 has already resolved the caller's real,
    authenticated identity and capped the requested role against it before
    this call is made; this endpoint just records that decision so
    `/approval/redeem` has something real to look up by uid instead of
    trusting whatever role string arrives with the redeem request itself.

    Overwrites any prior entry for the same uid — a participant's role can
    change (e.g. handing off Incident Commander mid-bridge), and the roster
    should reflect only their current one.
    """
    current = session(body.get("channel"))

    try:
        uid = int(body.get("uid"))
    except (TypeError, ValueError):
        return {"error": "uid is required and must be an integer"}

    role = str(body.get("role") or "")
    current.roster[uid] = {
        "role": role,
        "authorized": bool(body.get("authorized")),
        "actor_name": body.get("actorName") or body.get("actor_name"),
        "actor_user_id": body.get("actorUserId") or body.get("actor_user_id"),
    }
    log.info("bridge: roster recorded uid=%s role=%r authorized=%s", uid, role, current.roster[uid]["authorized"])
    return {"ok": True}


@router.post("/close-out")
async def bridge_close_out(body: dict[str, Any]) -> dict[str, Any]:
    """
    W9 — the moment the architecture pays off.

    States what was established and by whom, what remains unresolved, and then
    says plainly that root cause is not established.
    """
    current = session()
    ledger = current.ledger

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
    await current.hub.publish({"phase": "resolved"})

    voice = speech(current)
    if not voice.has_agent:
        return {"spoken": False, "reason": "no agent registered", "text": line}

    result = await voice.say(line, preempt=True)
    return {"spoken": bool(result and result.ok), "text": line}


@router.post("/say")
async def bridge_say(body: dict[str, Any]) -> dict[str, Any]:
    """
    Escape hatch for rehearsal and S0. Still validated against §6 — there is no
    path through this service that can emit a diagnosing sentence.
    """
    current = session()
    voice = speech(current)

    if not voice.has_agent:
        return {"error": "no agent registered — POST /agent/register first"}

    try:
        result = await voice.say(
            body.get("text", ""), force=bool(body.get("force")),
        )
    except EpistemicViolation as exc:
        return {"error": str(exc)}

    if result is None:
        return {"spoken": False, "reason": "suppressed by the interruption floor"}
    return {"spoken": result.ok, "status": result.status, "latencyMs": result.latency_ms}


@router.post("/interrupt")
async def bridge_interrupt() -> dict[str, Any]:
    current = session()
    voice = speech(current)
    if not voice.has_agent:
        return {"error": "no agent registered"}
    return {"ok": await voice.interrupt()}
