# 📋 Engineering Handoff Log — EchoSphere AI Incident Commander
## For Any Agent or Developer Picking Up This Project

> **Last Updated:** September 12, 2026  
> **Architecture Version:** Golden Master **v6** (`echosphere_architecture_v6.md`) + Redis Streams & Qdrant Vector DB  
> **Current Status:** **100% Ready & Passing.** Backend (334 tests) + Frontend (172 tests, typecheck, lint, build) all green.
> **⚠️ START HERE:** read `docs/session_log.md` first — it carries the cross-session memory (decisions, dead ends, corrections) that this file and the git history do not.
>
> **Repository:** https://github.com/aryanmehra0/EchoSphere.git  
> **Git Identity:** `aryanmehra0` (local config only)

---

## 1. What Is This Project?

A real-time **AI Incident Commander** named "Echo" for the **EchoSphere: Agora Conversational AI Hackathon**. Echo joins a live voice bridge during a technical outage, listens to multiple engineers talking (even simultaneously), organises their chaotic discussion into a structured knowledge graph, detects contradictions, tracks decisions, and takes action — in real time with sub-second voice latency, **without ever determining the root cause itself.**

### The Core Innovation
A **Dual-Loop Architecture** that splits voice interaction (fast, sub-second Agora Conversational AI + Groq) from heavy analytical reasoning (slow, accurate Python DDD Slow Loop with Evidence Ledger, Deliberation Panel, and Qdrant Semantic Memory), bridged by deterministic REST tools and verified speech synthesis.

---

## 2. Current Repository Structure

```
EchoSphere/
├── docker-compose.yml                 # PostgreSQL (5434), Redis 7 (6379), Qdrant (6333)
├── start.ps1 / start.sh               # Unified orchestrator (with -Tunnel and -Reset)
├── validate.ps1                       # 28-point live verification harness
├── docs/
│   ├── session_log.md                 # ← CROSS-SESSION MEMORY (Read First)
│   ├── echosphere_architecture_v6.md  # Governing architecture
│   ├── DEMO.md                        # Shark-tank style demo runbook
│   └── handoff_log.md                 # THIS FILE
│
├── backend/                           # ZONE 3 — Privileged Python Slow Loop (334 tests)
│   ├── app/
│   │   ├── domain/                    # EvidenceLedger, Claim models, Deliberation Panel, Rule 1 Tripwire
│   │   │   ├── policies/              # Contradiction, Utterance, Privacy, Authorization, Reconciliation
│   │   │   └── services/              # Telemetry, Hypothesis Elimination, Projects
│   │   ├── application/services/      # Ingestion pipeline, Turn Windows, Speech Coordinator, Budget
│   │   ├── infrastructure/            # Redis Streams, Qdrant Vector Store, Agora Agent, Dual-tier DB
│   │   └── web/                       # FastAPI routes, middleware, /ws/deltas, tool webhooks
│   └── tests/                         # Comprehensive test suites
│
└── frontend/                          # ZONE 1 & ZONE 2 — Next.js 16 Console (172 tests)
    ├── src/
    │   ├── app/                       # globals.css (Design System), page.tsx, API routes
    │   ├── components/                # IncidentConsole, GraphCanvas, Ledger, Theories, BridgeControls
    │   ├── lib/
    │   │   ├── incident-reducer.ts    # Single source of client truth
    │   │   ├── delta-socket.ts        # Resilient WebSocket connector
    │   │   └── server/                # ZONE 2 (server-only: Agora tokens, Roster, Agent config)
    └── tests/                         # Node test runner evaluation suite
```


> [!IMPORTANT]
> `src/` convention with the `@/*` → `./src/*` alias. Components live in
> `src/components/`, pages in `src/app/`.

---

## 3. Phase 1 — What Was Built (and re-built)

Phase 1 was scaffolded, then **rewritten end to end on 25 Aug** against two
goals from the user: a genuinely senior UI/UX rather than a generic AI
dashboard, and a structure that Phase 2/3 can plug into without rework.

### 3.1 The design system — `src/app/globals.css`

**Read this file before writing any UI.** It is the single source of truth and
it is heavily commented with the reasoning behind each decision.

The visual language is a **mission-control console** — Bloomberg Terminal, air
traffic control, IBM Carbon. Explicitly NOT the default "AI product" look.

| Decision | Rationale |
|---|---|
| Graphite surface ramp, never pure black | `#000` crushes hairlines and blooms on projectors |
| Exactly 3 hairline weights; **no glassmorphism** | Depth from rules + a 1px inset top highlight, not backdrop-blur |
| 4-stop ink ramp | A 5th stop means the hierarchy is wrong |
| **Saturated colour ONLY for signal** | `critical` / `warning` / `stable` / `live`. If a button borrows red, red stops meaning "broken" |
| IBM Plex Sans + Plex Mono | Drawn for technical systems; reads as instrumentation |
| Type scale tighter than a marketing site | Base is 13.5px — operators read at density |
| Small radii (3–8px) | Large radii read as consumer software and cost horizontal space |
| One easing curve, motion only on state change | Nothing moves to attract attention |
| Status never encoded by colour alone | ~1 in 12 men can't separate our red/green; it gets projected |

### 3.2 Architecture — the important part

```
   Phase 2 (Agora RTM)  ┐
   Phase 3 (WebSocket)  ├──► IncidentAction ──► incidentReducer ──► UI
   Phase 1 (replay)     ┘
```

Everything funnels through **one reducer**. The component tree cannot tell
where its actions came from. Consequences:

- **`src/lib/types.ts` is the contract.** It mirrors v6 §9.4 field-for-field,
  so the S3 payload deserialises with no adapter.
- **`src/lib/mock-stream.ts` is not throwaway.** It emits real `IncidentAction`
  objects, so it doubles as the rehearsal harness and the test fixture.
- **RTM deduplication lives in the reducer**, not a component — it is domain
  logic and must hold for replays and reconnect backfills too.

> [!TIP]
> **The Phase 2/3 integration point is `openBridge()` in
> `src/lib/incident-store.tsx`.** It is commented with exactly what to replace.
> Nothing below it changes.

### 3.3 Notable implementation details

| Detail | Why |
|---|---|
| `useVoiceEnvelope` writes `style.height` directly in rAF | The naive version calls `setState` 60×/sec forever, reconciling the tree next to a transcript someone is reading |
| `useClock` uses `useSyncExternalStore` | The wall clock is an external system. One interval for the whole app, no hydration mismatch, no cascading render |
| Graph nodes/edges are `useMemo` projections | React Flow's `useNodesState` would drift from the reducer when a delta and a drag land in one frame |
| Canvas is read-only (no drag, no hand-wiring) | The graph is evidence of what was said. If you can draw on it, it stops being evidence |
| 8 handles per node; edges pick by direction | Default source-right/target-left routes arrows back through their own source card |
| `IncidentEntity` is a `type`, not an `interface` | React Flow needs `Record<string, unknown>`; TS gives implicit index signatures to type aliases only |
| Transcript auto-scroll only while pinned to the tail | Yanking the viewport while someone reads backlog makes a live feed unusable |
| Muted is the LOUD state | The failure mode that costs minutes is talking into a dead mic |
| No dismiss "X" on the contradiction alert | Sweeping a conflict away without adjudication is the exact failure the feature prevents |
| Ledger is ONE claim table, three projections | v6 §9.1 — makes fact-vs-assumption a *query*, not a convention two arrays follow |
| `INFERRED` rendered dashed + badged, never spoken | v6 §6.2 Rule 3. The visual quarantine is what a judge sees; the Bridge filter (S5) is what enforces it |
| `unchecked[]` has its own panel | Requirement 5's quiet half. "Nobody checked the network path" is only sayable if the gap is a row in a table |
| `Task.evidence[]` links claims | v6 §9.4 — makes "why are we doing this?" answerable, and feeds the Authorization Gate modal |

---

## 4. The Verification Gate

**No slot ships until its slice of the evaluation framework passes.**

```bash
cd frontend
npm run verify     # typecheck → lint → tests → production build
npm run test       # Rehearsal Rig Tier 1
```

Status: **72/72 passing.** `node:test` with Node's native TypeScript
stripping — no test-runner dependency was added. This suite IS Tier 1 of the
Rehearsal Rig (v6 §15): recorded fixtures driving the pure reducer, in CI on
every commit.

`tests/phase1-evaluation.test.ts` is explicit about what Phase 1 **cannot** yet
prove (marked `⊘`). See the Evaluation Ledger in `docs/task.md`.

### The epistemic tests are the important ones

v6 §6 is the architectural answer to the brief's *"without pretending to
independently determine the root cause"*. Three rules, all enforced in Tier 1:

| Rule | How it is tested |
|---|---|
| 1 — attribution mandatory | Every Echo utterance reporting a finding must name a source |
| 2 — causation interrogative | A causal-indicative regex tripwire runs over all Echo output. **Note the negative lookahead** on `root cause is` — the close-out is *required* to say "root cause is not established" |
| 3 — `INFERRED` never spoken | No inferred claim's text may appear in any Echo turn |

### The trust-zone boundary (v6 §10.1)

S1 added server code, so the old blanket "no secrets anywhere in src/" became
wrong in both directions. It is now a **boundary**, enforced twice:

| Layer | Mechanism | Speed |
|---|---|---|
| Build | `import "server-only"` in every Zone 2 module | fails the build |
| Test | `Zone 1 cannot import Zone 2` scans the client tree | names the file in ms |

Both were verified by deliberately importing `serverEnv` into a client
component: the test failed instantly and the build refused to compile.

**Zone 2 holds Agora credentials only.** Jira / Slack / PagerDuty keys belong
in Zone 3 behind the Proxy Action Layer — a test fails if one appears here,
because it would change a Next.js compromise from "can talk on one bridge"
into "can page a human at 3am".

> [!WARNING]
> The v5 demo script had Echo say *"That points to a network partition… rather
> than a cache failure"* and close with *"Root cause: network partition."* v6
> §6.3 tabulates both as violating the brief. `mock-stream.ts` has been rewritten
> to Demo Script v2 (§18) and the tripwire now fails the build if diagnosing
> language returns. **Do not "improve" Echo's lines by making them more
> confident.** Restraint is the product.

## 5. What's Next — S0, the Bridge Spike

v6 §17 reorders the plan around risk: **the Bridge is proven first, not last**
(closes G9). Before any analytics exist, a throwaway script must show that both
Bridge directions work — injection < 500ms, `interrupt` genuinely interrupts,
tool round-trip < 400ms. If it fails, fall back to the RTM text path with six
days remaining instead of one.

Then S1:

| Task | Details |
|---|---|
| `/api/token` | RTC + RTM tokens via `agora-token`. Needs `AGORA_APP_ID` + `AGORA_APP_CERTIFICATE`. Accepts `channelName`, `uid`, `role`. |
| `/api/invite-agent` | Agora Conversational AI Engine REST API. `openai` vendor, `gpt-4o-realtime-preview`, system prompt from master doc §8.1. |
| `104 agent expire` | Webhook listener → Update Agent API with a fresh token. |
| Wire the real stream | Replace the replay in `openBridge()`; dispatch `TRANSCRIPT` from the RTM handler. |
| Wire real audio | Pass the subscribed remote track into `useVoiceEnvelope({ track })`. |

Required agent config:
```json
{
  "turn_detection": {
    "mode": "agora_vad",
    "interrupt_duration_ms": 160,
    "prefix_padding_ms": 800,
    "silence_duration_ms": 640,
    "threshold": 0.5,
    "language": "en-US"
  },
  "idle_timeout": 300
}
```

> [!WARNING]
> **BLOCKING for Phase 2:** `frontend/.env.local` EXISTS but every value in it
> is blank (verified Aug 27 via `/api/health` on a freshly booted server). The
> user must fill in the five values (see §7). Note that `next build` printing
> `Environments: .env.local` only means the file was found, not that it is set.
>
> Keep `AGORA_APP_CERTIFICATE` and `OPENAI_API_KEY` server-side only — a Phase 1
> test fails the build if either name appears anywhere under `src/`.

---

## 6. Critical Architectural Decisions (Do NOT Change)

1. **Dual-Loop split is mandatory.** Fast Loop = voice. Slow Loop = analytics. Separate processes.
2. **Diarisation MUST use `on_playback_audio_frame_before_mixing`.** Client-side volume indicators are unreliable.
3. **Stream `vad_result_bytearray`, NOT raw frames.**
4. **The Bridge uses v2.6 Custom Instruction Injection.** The Slow Loop never speaks directly.
5. **Token renewal via the `104 agent expire` event.**
6. **`priority: high` for contradiction alerts** so the agent interrupts rather than queues.
7. **VAD mode is `agora_vad`, NOT `server_vad`.**
8. **All incident state flows through `incidentReducer`.** *(Added Phase 1.)* No component may hold its own copy — it is what makes §10.3 determinism provable.
9. **Saturated colour is reserved for status.** *(Added Phase 1.)* See §3.1.
10. **Echo never asserts causation.** *(v6 §6.)* Attribution is mandatory, causal language is interrogative only, and `INFERRED` claims never reach the voice channel. Enforced by tests — see §4.
11. **Voice is an intent signal, never an authorization.** *(v6 §10.2, closes G7.)* Approval is a nonce + TTL + argsHash token redeemed by a UI click from the authorized role. Two independent channels must agree.

---

## 7. Environment Variables Required

`frontend/.env.local`:
```env
AGORA_APP_ID=<from Agora Console>
AGORA_APP_CERTIFICATE=<from Agora Console>
OPENAI_API_KEY=<from OpenAI dashboard>
NEXT_PUBLIC_AGORA_APP_ID=<same as AGORA_APP_ID, for client-side SDK>
```

`backend/.env` (Phase 3):
```env
AGORA_APP_ID=...
AGORA_APP_CERTIFICATE=...
ASSEMBLYAI_API_KEY=...
OPENAI_API_KEY=...
PINECONE_API_KEY=...
```

---

## 8. How to Run

```bash
cd frontend
npm install        # if node_modules is missing
npm run dev        # http://localhost:3000
npm run verify     # the gate
```

Click **Join incident bridge** (or press `J`) to run the ~50s scripted replay of
the master-doc §11 demo. `M` toggles mute.

---

## 9. Known Issues & Gotchas

| Issue | Severity | Details |
|---|---|---|
| `.env.local` present but all values blank | BLOCKING for Phase 2 | Verify with `/api/health`, never by reading the file. See §7 |
| `allowImportingTsExtensions` in tsconfig | INFO | Node's type-stripping requires `.ts` in test imports; safe because tsc never emits here |
| Dev server may already be running | INFO | Next refuses a second dev server on the same dir; reuse the running one |
| Git is local-scoped | INFO | Verify `git config user.email` before committing |

---

## 10. Reference Documents

| Document | Purpose |
|---|---|
| `docs/session_log.md` | **Cross-session memory.** Decisions, corrections, environment notes, what NOT to do. Read first. |
| `docs/echosphere_architecture_v6.md` | **THE GOVERNING ARCHITECTURE.** Nine gaps, bidirectional Bridge, epistemic ledger, ten workflows, Rehearsal Rig, risk-ordered plan |
| `docs/echosphere_master_context.md` | v5 — superseded. Kept as the record of what v6 §2 analysed |
| `docs/implementation_plan.md` | v5 EDD — superseded |
| `docs/task.md` | Checklist + §10 Evaluation Ledger |
| `frontend/src/app/globals.css` | The design system, with reasoning |
| `frontend/src/lib/types.ts` | The Slow-Loop data contract |

> [!CAUTION]
> **For any agent continuing this work:** read `docs/session_log.md`, then
> `docs/echosphere_architecture_v6.md` — especially §6 (epistemic
> discipline) and §17 (why the Bridge spike comes first). Then
> `frontend/src/app/globals.css` and `frontend/src/lib/types.ts`. Do not deviate from that architecture, or
> from the design system, without explicit user approval. Run `npm run verify`
> before declaring anything done.
