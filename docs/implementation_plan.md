# Engineering Design Document: Real-Time AI Incident Commander (Golden Master v5 - ARCHIVE)

> [!WARNING]
> **SUPERSEDED / LEGACY RECORD (DO NOT FOLLOW)**
> This document was the preliminary v5 plan from early hackathon scaffolding. It has been completely superseded by **Golden Master Architecture v6** (`docs/echosphere_architecture_v6.md`) and the code-grounded **`ARCHITECTURE.md`**.
> For cross-session memory, see `docs/session_log.md`.


## 2. The Flawless "Dual-Loop" Architecture

### A. The Fast Loop: Core Voice Interaction (Next.js + OpenAI Realtime)
- **Objective:** Sub-second, conversational AI interaction.
- **Mechanism:** The Next.js API (`/api/invite-agent`) launches the Agora Cloud Agent, natively bound to the OpenAI Realtime API (`wss://api.openai.com/v1/realtime`).
- **Configuration:** `agora_vad` mode, `interrupt_duration_ms: 160`, and `prefix_padding_ms: 800`.

### B. The Slow Loop: Perfect Diarization & Analytics (Python Server SDK)
- **Objective:** Flawless role mapping, extraction, and UI updates during overlapping chaos.
- **Mechanism:** A headless Python worker intercepts unmixed audio via `on_playback_audio_frame_before_mixing`.
- **Server-Side RTI:** Calculates the Room Tension Index mathematically using `vad_result_state`.
- **Audio Optimization (New):** Instead of streaming the raw frame data to the STT provider, the Python worker will exclusively stream the `vad_result_bytearray`. By only sending validated speech data, we drastically optimize bandwidth and STT processing overhead.

### C. The Bridge: Custom Instruction Injection
- **Mechanism:** We utilize the Agora Conversational AI Engine v2.6 **Custom Instruction Injection API endpoint**.
- **Execution:** When the Python backend detects a semantic contradiction, it sends a hidden prompt injection to the agent (e.g., *"System Alert: Contradiction detected. Interrupt and clarify."*).
- **Parameters:** `on_listening_action: "inject"`, `on_speaking_action: "interrupt"`.

## 3. High-Polish UX & Frontend Resilience

### I. RTM Transcript Deduplication
- **The Fix:** The Next.js frontend uses a deduplication controller leveraging `message_id` and `timestamp`. Temporary phrases are overwritten seamlessly until `is_final: true` is received.

### II. Web Audio API Visualization
- **The Fix:** We pipe the agent's incoming audio track through the browser's `Web Audio API AnalyserNode` to power a dynamic waveform visualization on the dashboard.

## 4. Operational Stability & Security

### I. Token Expiry Management (New)
- **The Risk:** Long-running incidents will outlast the default 1-hour Agora token, causing the AI to abruptly drop from the call.
- **The Fix:** The Next.js backend will actively listen for the `104 agent expire` event from the Conversational AI Engine. Upon receipt, it will immediately call the Update Agent API with a freshly generated token, seamlessly renewing the session without disruption.

### II. Testing Frameworks
- **The Stranger Test:** Read-only defaults and explicit Human-in-the-Loop verbal authorization for critical API calls.
- **Blast Radius Assessment:** Complete credential isolation in the Python backend; Next.js frontend strictly isolated to UI state management.
- **Repeated Iteration Testing:** Fast Loop fetches answers from a deterministic `IncidentState.json`, preventing AI hallucination during repeated inquiries.

## 5. Execution Timeline (The Blueprint)

We will structure the workspace in `C:\Users\Nithya\.gemini\antigravity-ide\scratch\echosphere-incident-commander`.

1. **Phase 1: Next.js Foundation & UI**
   - Scaffold the Next.js app, configure Tailwind, and build the React Flow dashboard.
   - Implement transcript deduplication and waveform visualization.
2. **Phase 2: The Fast Loop & Token Management**
   - Build `/api/token` and `/api/invite-agent`.
   - Implement the webhook listener for the `104 agent expire` event to trigger token renewal.
3. **Phase 3: The Slow Loop (Python Backend)**
   - Implement the headless Agora Python worker utilizing `vad_result_bytearray` streaming.
   - Implement the Vector DB semantic contradiction engine and RTI calculation.
4. **Phase 4: The Bridge**
   - Connect the Python backend to the v2.6 Custom Instruction Injection endpoint.
