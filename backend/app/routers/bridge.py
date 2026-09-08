"""
The Bridge — Echo's proactive voice.

Every route here goes through `SpeechCoordinator`, so the §6 gate and the
degradation bookkeeping apply identically no matter which one was called.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from ..adapters.agora_bridge import BridgeController
from ..deps import session, speech
from ..models import now_ms
from ..utterance import EpistemicViolation, close_out

log = logging.getLogger("echo.bridge.routes")

router = APIRouter(prefix="/bridge")


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
