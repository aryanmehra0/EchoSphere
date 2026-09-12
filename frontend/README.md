# EchoSphere — Zone 1 & Zone 2: Real-Time Incident Command Console

The frontend console for EchoSphere, built with **Next.js 16 (Turbopack)** and **React 19**.

## Architecture & Trust Zones

- **Zone 1 (Browser Client)** (`src/components/**`, `src/hooks/**`):
  - Consumes the single source of truth: `incidentReducer` (`src/lib/incident-reducer.ts`).
  - Connects to the Slow Loop via WebSocket `/ws/deltas` (`src/lib/delta-socket.ts`) with HELLO / SNAPSHOT / REPLAY recovery.
  - Interactive knowledge graph powered by `@xyflow/react` (React Flow) with customized entity nodes and collision-free edge routing.
  - Mission-control design system in `src/app/globals.css` using **IBM Plex Mono** & **IBM Plex Sans**.
  - Audio waveform visualization via Web Audio API `AnalyserNode` in `src/hooks/useVoiceEnvelope.ts`.
  - Never sees or imports Agora credentials (enforced by compiler & tests).

- **Zone 2 (Next.js Server / API Routes)** (`src/lib/server/**`, `src/app/api/**`):
  - Marked `import "server-only";` — any leakage to client code causes a build failure.
  - Mints short-TTL Agora RTC/RTM tokens with strict role authorization (`src/lib/server/agora-tokens.ts`).
  - Maintains the human participant roster and agent exclusion set (`src/lib/server/roster.ts`).
  - Configures the Fast Loop agent prompts, epistemic rules, and VAD parameters (`src/lib/server/agent-config.ts`).
  - Proxies requests to the Python Slow Loop (:8000) so browser traffic is same-origin.

---

## Commands

```bash
# Install dependencies
npm install

# Run the Rehearsal Rig verification gate (typecheck -> lint -> tests -> build)
npm run verify

# Run unit and integration tests (172 tests)
npm test

# Start Next.js development server (Turbopack on port 3100)
npm run dev

# Run live conversation check
npm run demo converse
```

---

## Environment Variables

Configured in `frontend/.env.local`:

```ini
AGORA_APP_ID=...
AGORA_APP_CERTIFICATE=...
AGORA_CUSTOMER_ID=...
AGORA_CUSTOMER_SECRET=...
GROQ_API_KEY=...
TTS_VENDOR=elevenlabs          # or sarvam
ELEVENLABS_API_KEY=...
AGENT_TOOL_BASE_URL=https://...trycloudflare.com
AGENT_TOOL_SECRET=...
```

