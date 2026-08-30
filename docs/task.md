# EchoSphere Hackathon Execution Tasks

> **Cross-session memory:** `session_log.md` — read it before starting work.
>
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
- `[x]` **Agora credentials in and preflighted** (Aug 27) — token mints, customer
  pair authenticates, app id belongs to the account, Conversational AI enabled
- `[x]` **`/api/token` verified LIVE** (Aug 27) — real certificate, uid 1002,
  `authorized:true`, valid RTC + RTM tokens, sequential roster allocation held
- `[x]` **Real SD-RTN join verified** via `public/listen.html` — a throwaway
  listener built because nothing in `src/` could join a channel. **Delete it
  when the line below lands.**
- `[x]` **Fast Loop re-platformed to Groq** (Aug 27) — cascaded ASR → LLM → TTS,
  since no OpenAI key was obtainable. `agent-config.ts`, `env.ts`,
  `/api/invite-agent`, the spike and `.env.local.example` all updated;
  **78 tests pass**, six of them new and covering the TTS param names Agora
  refuses to validate
- `[x]` **`/api/invite-agent` verified end to end** — `HTTP 200`, live agent
  launched and stopped (placeholder TTS key held in memory, never written to disk)
- `[x]` **TTS key in and verified** (Aug 28) — ElevenLabs. `/api/health` returns
  `ready:true`; Echo measured speaking at 80–87% peak on a live channel.
  (Sarvam also wired but **broken upstream** — Agora's adapter is pinned to the
  deprecated `bulbul:v2`; see `session_log.md`.)
- `[x]` **Live RTM transcript path** — `listen.html` subscribes to Agora ASR over
  RTM and forwards each final utterance to the Slow Loop, so the dashboard fills
  itself from real speech. Defensive parser verified against 8 payload shapes;
  Echo's own transcripts filtered client-side (G2)
- `[ ]` Move that path into the console itself (it lives in the listener today)
- `[ ]` Feed the real remote track into `useVoiceEnvelope`
- `[ ]` Observer self-renewal on its own T-minus-300s timer (Python, S2)
- `[ ]` **Gate:** two humans + Echo in a channel; every UID resolves to a role

## Zone 3 scaffolded · Aug 28 — `backend/` NOW EXISTS

FastAPI service, 13 tests, verified end to end on a live channel.

- `[x]` `backend/` created — venv, requirements, README, 13 passing tests
- `[x]` **`utterance.py` — Rules 1–2 enforced IN CODE.** `/speak` sends our exact
  sentence, so a claim without a source or a causal indicative **cannot be
  constructed**. §6.2's admitted weakness ("prompt-enforced, could be violated
  by a creative model") no longer applies to Echo's proactive speech
- `[x]` `bridge.py` — Bridge Controller on `/speak` + `/interrupt`, INFERRED
  filter (Rule 3), 12s interruption floor, coalescing window
- `[x]` `ledger.py` — one claim table, four statuses, frontend-mirroring selectors
- `[x]` `deltas.py` — `seq` + HELLO / SNAPSHOT / REPLAY *(closes G6 server-side)*
- `[x]` `main.py` — observer ingress with **uid 9000 exclusion (G2)**, ledger
  writes, `query_incident_state` tool webhook *(closes G1 server-side)*, WS socket
- `[x]` **FULL STACK VERIFIED:** browser → Next.js → Python → Agora → Groq →
  ElevenLabs. Composed intervention spoken at **87% peak**, 485ms Bridge
  latency, inferred claim correctly absent, close-out states root cause not
  established
- `[x]` **Client half done: dashboard connects to `/ws/deltas`** — `delta-socket.ts`
  with HELLO / SNAPSHOT / REPLAY, backoff, and gap detection while connected;
  `SNAPSHOT` reducer action that REPLACES rather than merges
- `[x]` **G6 VERIFIED END TO END** — reload mid-incident restored the ledger
  from SNAPSHOT in a real browser
- `[x]` Scripted replay retained as the automatic fallback (§17), with the
  status bar showing **LIVE DATA** vs **REHEARSAL** so a replay can never pass
  as a live incident
- `[x]` `POST /incident/reset` — clean state between the three S6 rehearsals
- `[x]` **`redaction.py`** — PII stripped BEFORE the LLM and before any index (§10.4)
- `[x]` **`extraction.py`** — Turn Window, §14.2 prompt, schema validation + repair
  retry, compaction with pinned obligations, **entity resolution done in code**
- `[x]` **`contradiction.py`** — the two-stage engine *(closes G4)*
- `[x]` **Pipeline wired**: speech → extraction → Ledger → deltas → Bridge
- `[x]` **Enum coercion both sides** — an LLM-fed wire can no longer blank the UI
- `[x]` **`rti.py`** — normalized, EWMA, Schmitt hysteresis, 90s cooldown *(closes G5)*
- `[x]` **`authorization.py` + `proxy.py`** — nonce + TTL + argsHash + role-bound
  gate, three-tier classification, idempotency *(closes G7)*
- `[x]` **Rehearsal Rig Tier 2** — real pipeline over fixed fixtures, scored *(closes G8)*
- `[x]` **Contradiction reliability fixed and MEASURED** — 20% → 100% detection
  on the primary model, precision held at 100% throughout. Four changes, each
  scored by Tier 2 rather than guessed. See `session_log.md`.
- `[ ]` ⚠️ **Groq daily token cap (200k TPD, per model).** Today's tuning
  exhausted `gpt-oss-120b`. A model fallback chain keeps the pipeline alive but
  the smaller models are worse at adjudication, so the S6 gate holds on the
  PRIMARY model only. Budget ~15–20k tokens per full run.

## S2 — Observer + source separation · Aug 30 — BLOCKED ON PYTHON VERSION

- `[x]` **Agent-UID exclusion implemented** at the observer seam *(closes G2)*
- `[x]` Observer built as a pluggable adapter; HTTP ingress works today
- `[ ]` ⚠️ `agora-python-server-sdk` has **no wheel for Python 3.14** and fails
  to build. 3.14 is the only interpreter installed. Real per-UID audio needs a
  3.12 venv — see `backend/README.md`
- `[ ]` `vad_result_bytearray` → STT once a 3.12 interpreter exists
- `[ ]` **Gate:** 60s of Echo speech produces **zero** claims from uid 9000

## S3 — Ledger + extraction + deltas · Aug 31 — 🟡 HALF DONE

- `[x]` Claim table with `epistemicStatus`; emits `IncidentDelta` — `ledger.py`
- `[x]` Delta Hub: `seq` + HELLO / SNAPSHOT / REPLAY *(closes G6)*
- `[x]` Client half of the reconnect protocol — `delta-socket.ts`
- `[x]` **Half the gate met:** reload → graph survives ✅ (verified in a browser)
- `[x]` Turn Window, PII redaction, extraction LLM — **done**
- `[x]` **Gate met:** a spoken sentence becomes a graph node automatically;
  reload → graph survives. Verified live with 0 console errors.

## S4 — Contradiction + RTI · Sep 1 — NOT STARTED

- `[x]` **Two-stage** scope → retrieve → cooldown → adjudicate *(closes G4)*
- `[ ]` Embedder — lexical overlap stands in; no embedding vendor is configured
- `[ ]` RTI: normalized, EWMA, hysteresis *(closes G5)*
- `[ ]` **Gate:** contradiction fires exactly once; ≤ 2 RTI interventions in 3 min

## S5 — Bridge integration + gate · Sep 2 — NOT STARTED

- `[x]` **Bridge Controller built early** — `/speak` + `/interrupt`, priority
  discipline, 12s interruption floor, coalescing window (`backend/app/bridge.py`)
- `[x]` **`INFERRED` filter in the Bridge Controller** — the structural half of Rule 3
- `[x]` **Rules 1–2 now structural too** — `utterance.py` composes Echo's exact
  words, so an unattributed or causal sentence cannot be constructed
- `[ ]` BEACON channel (periodic state sync)
- `[x]` **Proxy Action Layer, three-tier classification** — unknown actions fail
  CLOSED (treated as CRITICAL)
- `[x]` **Authorization Gate** *(closes G7)* — verified live end to end: verbal
  "yes, approved" logs `authorized:false`; wrong role REJECTED; correct role
  files a ticket; replayed nonce REJECTED; every outcome audited
- `[x]` Approval modal showing args + evidence chain, with a visible TTL
  countdown and no dismiss control
- `[x]` **W5 verified**; W3 verified via Tier 2 and the live console

## S6 — Rig + degradation + rehearse · Sep 3 — NOT STARTED

- `[x]` **Rehearsal Rig Tier 2** *(closes G8)* — 5 scenarios, scored, paced
- `[x]` Degradation: LLM model fallback chain on daily-quota exhaustion
- `[x]` **Degradation ladder** — `degradation.py`, edge-triggered, published to
  the dashboard as a command-bar banner naming the CONSEQUENCE not the component
- `[x]` **GATE MET (Aug 30):** three consecutive runs, 3/3 fully correct, all six
  Tier 2 metrics at 100% on the primary model
- `[ ]` Rehearsal Rig Tier 3 (recorded channel replayed into Agora)
- `[ ]` STT failover + injection fallback (the remaining §13 rows)

## S0 — Bridge Spike · Aug 26–28 · **RUN THIS FIRST** *(closes G9)*

**Exit criteria MET (Aug 28)** — though not by the mechanism v6 specified.
Instruction injection never produced speech; `/speak` and `/interrupt` do.
Measured: 80–87% peak audio, interrupt acknowledged in 433ms.

- `[x]` Spike script written, syntax-checked, fails cleanly without creds
- `[x]` **Two runtime bugs found and fixed (Aug 27)** — `join` shadowing killed
  the report write at the very end of a live run, and `agora-token` needs
  `.default` under plain Node. Neither was credential-related; the script could
  not have completed on any machine. See `session_log.md` §5.
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
| Reconnect at seq 51 deep-equals uninterrupted | 1 | ✅ SNAPSHOT replace + idempotent replay asserted |
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

`frontend/.env.local` **exists but every value is blank** (measured Aug 27: 5,032
bytes, all of it comments; `/api/health` on a freshly booted server returns
`ready:false` with all five `false`). The file being present is why `next build`
prints `Environments: .env.local` — that log line is *not* evidence the
credentials are set. Until the five values are filled in, S0 cannot run and no
API route can reach Agora. Fill them in —
note that `AGORA_CUSTOMER_ID`/`SECRET` are a **different credential** from
`AGORA_APP_CERTIFICATE`; conflating them is the most common setup failure.
