# Agora Native Audio Ingestion Sidecar

## Architectural Purpose

This sidecar micro-service resolves the dependency conflict between the **Python 3.14 Slow Loop** and the **Agora RTC C++ Server SDK** (`agora-python-server-sdk`), which requires Python <= 3.12.

### Responsibilities
1. Joins the Agora RTC audio bridge as a silent observer.
2. Subscribes to raw 16kHz signed 16-bit mono PCM frames via `on_playback_audio_frame_before_mixing`.
3. Enforces **Rule G2 (Agent-UID exclusion)** at the frame buffer level.
4. Computes Root Mean Square (RMS) energy, cadence, and Voice Activity Detection (VAD).
5. Forwards acoustic telemetry to the Slow Loop at `POST /observer/acoustic_telemetry` for live Room Tension Index (RTI) computation.

### Local Development / Running
```bash
docker build -t echosphere-audio-ingest services/audio-ingest/
docker run --network=host -e SLOW_LOOP_URL=http://localhost:8000 echosphere-audio-ingest
```

