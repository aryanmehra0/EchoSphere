"""
Audio Stream and Acoustic Telemetry Ingestion Router — Phase 4 Architecture.

────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

The Slow Loop runs on Python 3.14. The native Agora audio server SDK
(`agora-python-server-sdk`) requires Python <= 3.12 due to C extension
wheel availability.

This endpoint accepts streamed raw PCM frames or processed acoustic telemetry
(VAD, energy, pitch, speaking rate) from the decoupled audio-ingest sidecar,
allowing the Slow Loop to compute the acoustic Room Tension Index (RTI, v6 §8)
without needing C-extensions directly in the main service process.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.web.deps import session

log = logging.getLogger("echo.audio_stream")

router = APIRouter(prefix="/observer")


@router.get("/config")
async def get_observer_config() -> dict[str, Any]:
    """Return active session channel and agent UID for observer sidecar synchronization."""
    current_session = session()
    agent_id = (current_session.agent or {}).get("agent_id")
    return {
        "active_channel": current_session.channel,
        "agent_uid": int(agent_id) if agent_id and str(agent_id).isdigit() else None,
        "current_rti": round(current_session.ledger.rti, 3),
    }


@router.post("/acoustic_telemetry")
async def receive_acoustic_telemetry(body: dict[str, Any]) -> dict[str, Any]:
    """
    Receive real-time acoustic features extracted from raw PCM audio.
    Supports both single-frame payloads and window-batched payloads (Phase 5 P2).
    """
    channel = body.get("channel", "")
    uid = body.get("uid")
    active_uids = body.get("active_uids")

    if not channel:
        return JSONResponse({"error": "channel is required"}, status_code=400)
    if uid is None and not active_uids:
        return JSONResponse({"error": "uid or active_uids is required"}, status_code=400)

    # Check G2: ensure Echo's agent UID is rejected if mistakenly forwarded
    current_session = session()
    agent_id = (current_session.agent or {}).get("agent_id")
    agent_uid_str = str(agent_id) if agent_id is not None else None

    # Single-speaker G2 check
    if uid is not None and str(uid) == agent_uid_str:
        log.warning("audio_stream: rejected telemetry from Echo's own agent UID: %s", uid)
        return {"status": "dropped", "reason": "agent_self_exclusion"}

    # Multi-speaker G2 filtering
    if active_uids and isinstance(active_uids, list):
        filtered_uids = [u for u in active_uids if str(u) != agent_uid_str]
        if not filtered_uids and active_uids:
            return {"status": "dropped", "reason": "agent_self_exclusion"}
        active_uids = filtered_uids

    energy = float(body.get("energy_rms", 0.0))
    peak_energy = float(body.get("peak_energy_rms", energy))
    vad_active = bool(body.get("vad_active", False))
    overlap_detected = bool(body.get("overlap_detected", False))

    # Multi-factor RTI Update (v6 §8):
    # 1. Overlapping speech carries highest weight (0.45 in §8.1)
    if overlap_detected or (active_uids and len(active_uids) > 1 and vad_active):
        current_session.ledger.rti = min(1.0, current_session.ledger.rti + 0.10)
    # 2. Volume elevation
    elif vad_active and (energy > 0.08 or peak_energy > 0.12):
        current_session.ledger.rti = min(1.0, current_session.ledger.rti + 0.05)
    # 3. Decay on calm/silence
    elif not vad_active:
        current_session.ledger.rti = max(0.0, current_session.ledger.rti - 0.02)

    return {
        "status": "received",
        "channel": channel,
        "uid": uid if uid is not None else (active_uids[0] if active_uids else None),
        "current_rti": round(current_session.ledger.rti, 3),
        "overlap_detected": overlap_detected,
    }


