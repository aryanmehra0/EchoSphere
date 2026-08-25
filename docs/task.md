# EchoSphere Hackathon Execution Tasks

> **Governing architecture:** `echosphere_architecture_v6.md` (Golden Master v6).
> It supersedes `echosphere_master_context.md` (v5), which stays in the repo as
> the record of what v6's depth analysis was performed against.
>
> **Rule:** no slot is "done" until its slice of the evaluation framework passes.
> The gate is `npm run verify` in `frontend/` (typecheck → lint → tests → build).

---

## Phase 1 / Frontend Foundation — ✅ COMPLETE (v6-aligned 25 Aug 2026)

- `[x]` Scaffold Next.js application
- `[x]` Design system: semantic token layer, type scale, motion + a11y rules
- `[x]` Incident console shell (command bar, 3 columns, status bar)
- `[x]` Root-cause graph with custom entity nodes + direction-aware edge routing
- `[x]` RTM transcript deduplication *(in the reducer — v6 §4.6)*
- `[x]` Web Audio visualisation *(rAF → DOM, not React state)*
- `[x]` Typed data contract mirroring v6 §9.4
- `[x]` **Evidence Ledger with `epistemicStatus`** — v6 §6.1
- `[x]` **`INFERRED` quarantine** — dashed, badged, never spoken (§6.2 Rule 3)
- `[x]` **`unchecked[]` Gaps panel** — requirement 5's missing half (§9.4)
- `[x]` **Task evidence chains** — `evidence: claim_id[]` (§9.4)
- `[x]` **Demo Script v2 replay** — every Echo line satisfies §6
- `[x]` Contradiction alert with human adjudication gate
- `[x]` Rehearsal Rig **Tier 1** — 47 tests, all green

## S1 — Fast Loop + Roster · Aug 29 — 🟡 CODE COMPLETE, LIVE-GATED

Server side is built and unit-tested. Everything remaining needs credentials.

- `[x]` `/api/token` — write-before-token ordering *(closes G3)*
- `[x]` `/api/invite-agent` — §14.1 prompt, agora_vad 300ms, 5 tools
- `[x]` `/api/agent-events` — event 104 renewal, signature-verified
- `[x]` `/api/health` — credential preflight
- `[x]` Roster Service (in-process; Python takes over in S2)
- `[x]` Trust-zone boundary enforced by `server-only` + a test
- `[ ]` **BLOCKED:** create `frontend/.env.local` from `.env.local.example`
- `[ ]` Replace the replay driver with live Agora RTC join + RTM subscribe
- `[ ]` Feed the real remote track into `useVoiceEnvelope`
- `[ ]` Observer self-renewal on its own T-minus-300s timer (Python, S2)
- `[ ]` **Gate:** two humans + Echo in a channel; every UID resolves to a role

## S2 — Observer + source separation · Aug 30 — NOT STARTED

- `[ ]` Observer worker, `on_playback_audio_frame_before_mixing`
- `[ ]` **Agent-UID exclusion** *(closes G2 — Echo transcribing itself)*
- `[ ]` `vad_result_bytearray` → STT, role-tagged transcripts
- `[ ]` **Gate:** 60s of Echo speech produces **zero** claims from uid 9000

## S3 — Ledger + extraction + deltas · Aug 31 — NOT STARTED

- `[ ]` Turn Window, PII redaction, extraction LLM
- `[ ]` Claim table with `epistemicStatus`; emit `IncidentDelta`
- `[ ]` Delta Hub: `seq` + HELLO / SNAPSHOT / REPLAY *(closes G6)*
- `[ ]` Client half of the reconnect protocol
- `[ ]` **Gate:** speak a sentence → node on the graph in < 4s; reload → graph survives

## S4 — Contradiction + RTI · Sep 1 — NOT STARTED

- `[ ]` Embedder, in-process ANN index
- `[ ]` **Two-stage** scope → retrieve → cooldown → adjudicate *(closes G4)*
- `[ ]` RTI: normalized, EWMA, hysteresis *(closes G5)*
- `[ ]` **Gate:** contradiction fires exactly once; ≤ 2 RTI interventions in 3 min

## S5 — Bridge integration + gate · Sep 2 — NOT STARTED

- `[ ]` Bridge Controller — PUSH / QUERY / BEACON, single-slot pre-emptive queue
- `[ ]` **`INFERRED` filter in the Bridge Controller** — the structural half of Rule 3
- `[ ]` Proxy Action Layer, three-tier classification
- `[ ]` **Authorization Gate** — nonce + TTL + argsHash + role-bound *(closes G7)*
- `[ ]` Approval modal in the dashboard showing args + evidence chain
- `[ ]` **Gate:** W3 and W5 run end-to-end on a live channel

## S6 — Rig + degradation + rehearse · Sep 3 — NOT STARTED

- `[ ]` Rehearsal Rig Tiers 2 and 3 *(closes G8)*
- `[ ]` Degradation ladder
- `[ ]` **Gate:** demo runs clean three times consecutively

## S0 — Bridge Spike · Aug 26–28 · **RUN THIS FIRST** *(closes G9)*

Script is written and ready: `npm run spike -- --channel inc-spike`.
Blocked only on credentials.

- `[x]` Spike script written, syntax-checked, fails cleanly without creds
- `[ ]` **BLOCKED:** `.env.local`
- `[ ]` Launch agent with trivial prompt
- `[ ]` Inject hardcoded instruction; confirm it speaks; measure latency
- `[ ]` Confirm `on_speaking_action: interrupt` cuts off mid-sentence
- `[ ]` Define one tool, call it from voice, confirm webhook round-trip
- `[ ]` **Exit:** injection < 500ms, `interrupt` genuinely interrupts, tool < 400ms
- `[ ]` **If it fails:** fall back to the RTM text path and rescope — with six days left, not one

---

## Evaluation Ledger

`✅` = asserted by an automated test today.

### §6 Epistemic discipline — *the clause the brief turns on*

| Rule | Status | Where |
|---|---|---|
| Rule 1 — attribution mandatory | ✅ | Tier 1: every Echo line names a source |
| Rule 2 — causation interrogative | ✅ | Tier 1: causal-indicative tripwire over all Echo output |
| Rule 3 — `INFERRED` never spoken | ✅ fixture / ⬜ enforcement | Tier 1 asserts the fixture; the Bridge filter is S5 |
| Close-out declines root cause | ✅ | Tier 1 asserts the literal sentence |
| Every claim carries status + source | ✅ | Tier 1 |

### §10.1 The Stranger Test

| Criterion | Status | Closed by |
|---|---|---|
| Context | ⬜ | S5 — Beacon + Query channels |
| Memory | ⬜ | S3 — compaction policy |
| Scoped permissions | ⬜ | S5 — three-tier classification |
| Review | ✅ | Phase 1 — one auditable reducer |
| Audit | ⬜ | S5 — structured append-only log |
| Intervention | ⬜ | S5 — nonce-bound two-channel gate |
| Defined roles | ⬜ | S1 — Roster Service (Phase 1 asserts attribution exists) |
| Fair error handling | ✅ | Phase 1 — `epistemicStatus` makes it a data property |

### §10.2 Blast Radius

| Vector | Status | Closed by |
|---|---|---|
| Frontend holds no credentials | ✅ | Phase 1 — static assertion over `src/` |
| Frontend XSS surface | ✅ | Phase 1 — no raw HTML, no egress |
| Hallucinated API call | ⬜ | S5 — Proxy Action Layer |
| Prompt injection via voice | ⬜ | S5 — Authorization Gate |
| Stale token leak | ⬜ | S1 — `104` renewal |

### §10.3 / §15 Repeated Iteration

| Test | Tier | Status |
|---|---|---|
| Deterministic state (replay ×8 identical) | 1 | ✅ |
| Duplicate delta delivery idempotent | 1 | ✅ |
| Reconnect at seq 51 deep-equals uninterrupted | 1 | ⬜ S3 |
| Ask DB status ×8 → identical payloads | 2 | ⬜ S4 |
| Agent self-transcription (uid 9000) | 2 | ⬜ S2 |
| No unattributed causal assertion | 2 | ⬜ S4 (Tier 1 covers the fixture) |
| RTI stability under 3 min argument | 2 | ⬜ S4 |
| Human says "No" → no write | 3 | ⬜ S6 |

---

## Running the gate

```bash
cd frontend
npm run verify     # typecheck → lint → tests → production build
npm run test       # Rehearsal Rig Tier 1 (72 tests)
npm run spike      # S0 Bridge Spike — needs .env.local
curl localhost:3000/api/health   # which credentials are configured
```

## The one blocker

`frontend/.env.local` does not exist. Until it does, S0 cannot run and no API
route can reach Agora. Copy `.env.local.example` and fill in five values —
note that `AGORA_CUSTOMER_ID`/`SECRET` are a **different credential** from
`AGORA_APP_CERTIFICATE`; conflating them is the most common setup failure.
