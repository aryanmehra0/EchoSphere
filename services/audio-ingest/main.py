"""
Native Audio Ingestion Sidecar — Python 3.11 / Agora RTC C++ Engine.

── CURRENT STATUS: NOT YET WIRED TO REAL AUDIO ─────────────────────────────
This module's aggregation/telemetry-forwarding logic below (the RMS/VAD math
in `AcousticWindowAggregator` and `process_audio_frame`) is real and tested,
but nothing in this file actually calls it: there is no Agora RTC subscriber
here, so `process_audio_frame` is never invoked with a live audio frame in
this build, and the Room Tension Index feature it feeds
(`/observer/acoustic_telemetry` -> `RoomTensionService` -> the dashboard's
tension meter) stays permanently at its default in a real deployment.

`main()` used to log "ready" and return immediately — with this container's
`restart: unless-stopped` in `docker-compose.yml`, that meant a crash-loop:
exit near-instantly, get restarted, exit again, forever, doing nothing.
It now idles instead, which is honest about the actual state: a harmless
no-op sidecar, not a broken one.

To make this real: install Python 3.11/3.12 specifically for this
container (already true — see the Dockerfile), add
`agora-python-server-sdk` for real (it is declared in requirements.txt but
never imported here), and subscribe to `on_playback_audio_frame_before_mixing`
per-UID unmixed PCM, calling `process_audio_frame(uid, pcm_bytes, vad)` for
each frame. `backend/requirements.txt`'s own comment on why the MAIN Slow
Loop doesn't do this directly (no wheel for Python 3.14) is exactly why this
is a separate sidecar in the first place.
"""

from __future__ import annotations

import logging
import math
import os
import time
from typing import Any

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)s  %(message)s")
log = logging.getLogger("audio_ingest_sidecar")

SLOW_LOOP_URL = os.getenv("SLOW_LOOP_URL", "http://127.0.0.1:8000")
AGENT_TOOL_SECRET = os.getenv("AGENT_TOOL_SECRET", "")
CHANNEL = os.getenv("AGORA_CHANNEL", "inc-4417")
AGENT_UID = int(os.getenv("ECHO_AGENT_UID", "9999"))


def compute_rms(pcm_bytes: bytes) -> float:
    """Compute normalized Root Mean Square (RMS) energy from 16-bit signed PCM."""
    if not pcm_bytes:
        return 0.0
    count = len(pcm_bytes) // 2
    if count == 0:
        return 0.0
    import struct
    samples = struct.unpack(f"<{count}h", pcm_bytes[:count * 2])
    sum_squares = sum(s * s for s in samples)
    mean_square = sum_squares / count
    return math.sqrt(mean_square) / 32768.0


class AcousticWindowAggregator:
    """
    500ms Sliding Aggregation Window.
    Batches high-frequency PCM frame telemetry into 500ms summary payloads,
    reducing HTTP churn to the Slow Loop by ~95% and computing conversational
    overlap across multiple speakers.
    """

    def __init__(self, window_ms: int = 500) -> None:
        self.window_ms = window_ms
        self.reset()

    def reset(self) -> None:
        self.start_ms = int(time.time() * 1000)
        self.energies: list[float] = []
        self.active_uids: set[int] = set()
        self.vad_states: list[bool] = []
        self.concurrent_talkers_seen = False

    def add_frame(self, uid: int, energy: float, vad: bool) -> dict[str, Any] | None:
        if uid == AGENT_UID:
            # Rule G2: Echo never transcribes or analyses its own speech
            return None

        now = int(time.time() * 1000)
        self.energies.append(energy)
        self.vad_states.append(vad)
        if vad:
            if self.active_uids and uid not in self.active_uids:
                self.concurrent_talkers_seen = True
            self.active_uids.add(uid)

        # Flush window if window_ms has elapsed
        if now - self.start_ms >= self.window_ms:
            return self.flush()
        return None

    def flush(self) -> dict[str, Any]:
        count = len(self.energies)
        mean_rms = (sum(self.energies) / count) if count > 0 else 0.0
        peak_rms = max(self.energies) if count > 0 else 0.0
        vad_active = any(self.vad_states)
        overlap = self.concurrent_talkers_seen or (len(self.active_uids) > 1 and vad_active)

        payload = {
            "channel": CHANNEL,
            "window_ms": self.window_ms,
            "active_uids": list(self.active_uids),
            "energy_rms": round(mean_rms, 4),
            "peak_energy_rms": round(peak_rms, 4),
            "vad_active": vad_active,
            "overlap_detected": overlap,
            "timestamp_ms": int(time.time() * 1000),
        }
        self.reset()
        return payload


_aggregator = AcousticWindowAggregator(window_ms=500)


def sync_config_from_slow_loop() -> None:
    """Fetch active channel and agent UID from the Slow Loop."""
    global CHANNEL, AGENT_UID
    url = f"{SLOW_LOOP_URL}/observer/config"
    try:
        resp = requests.get(url, timeout=1.0)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("active_channel"):
                CHANNEL = data["active_channel"]
            if data.get("agent_uid"):
                AGENT_UID = int(data["agent_uid"])
            log.info("sidecar: synced config from Slow Loop: channel=%s, agent_uid=%s", CHANNEL, AGENT_UID)
    except Exception as exc:
        log.debug("sidecar: config sync skipped (%s)", exc)


def forward_telemetry_payload(payload: dict[str, Any]) -> None:
    """Send batched or single acoustic telemetry payload to Slow Loop."""
    url = f"{SLOW_LOOP_URL}/observer/acoustic_telemetry"
    headers = {"Content-Type": "application/json"}
    if AGENT_TOOL_SECRET:
        headers["x-echo-tool-token"] = AGENT_TOOL_SECRET

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=1.5)
        if resp.status_code != 200:
            log.warning("sidecar: failed to forward telemetry: HTTP %d", resp.status_code)
    except Exception as exc:
        log.warning("sidecar: error connecting to Slow Loop: %s", exc)


def process_audio_frame(uid: int, pcm_bytes: bytes, vad: bool = True) -> None:
    """Entry point for incoming PCM audio frames from Agora RTC engine."""
    energy = compute_rms(pcm_bytes)
    batched = _aggregator.add_frame(uid, energy, vad)
    if batched is not None:
        forward_telemetry_payload(batched)


IDLE_LOG_INTERVAL_S = 300  # 5 minutes — present in logs without spamming them


def main() -> None:
    log.info("Starting Audio Ingestion Sidecar (500ms Aggregation Window)")
    log.info("Target Slow Loop: %s, initial channel: %s", SLOW_LOOP_URL, CHANNEL)
    log.warning(
        "audio capture is NOT implemented in this build — no Agora RTC subscriber is "
        "wired up, so no acoustic telemetry will be sent and the Room Tension Index "
        "stays at its default. See this module's docstring for what's needed to make "
        "it real. Idling rather than exiting, so the container does not crash-loop."
    )

    sync_config_from_slow_loop()

    # Idle rather than return: this process previously exited right after the
    # line above, and `docker-compose.yml` runs it with `restart:
    # unless-stopped` — an immediate exit meant an immediate restart, forever,
    # doing nothing each time. Blocking here makes it a stable, harmless
    # no-op instead of a crash-loop. Re-syncing periodically costs nothing
    # and picks up a channel/agent UID change even though nothing here acts
    # on it yet.
    while True:
        time.sleep(IDLE_LOG_INTERVAL_S)
        sync_config_from_slow_loop()
        log.info("audio-ingest sidecar idle — no audio capture implemented in this build")


if __name__ == "__main__":
    main()
