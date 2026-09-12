# EchoSphere Hackathon Execution Tasks

> **Cross-session memory:** `session_log.md` — read it before starting work.
>
> **Governing architecture:** `echosphere_architecture_v6.md` (Golden Master v6) + `ARCHITECTURE.md`.
> Supersedes `echosphere_master_context.md` (v5).
>
> **Rule:** no slot is "done" until its slice of the evaluation framework passes.
> Gates: `npm run verify` in `frontend/` (172 tests, typecheck, lint, build) + `unittest` in `backend/` (334 tests).

---

## Phase 1 / Frontend Foundation — ✅ COMPLETE
- `[x]` Scaffold Next.js application
- `[x]` Design system: semantic token layer, IBM Plex scale, motion + a11y rules
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

## S1 — Fast Loop + Roster — ✅ COMPLETE & LIVE-VERIFIED
- `[x]` `/api/token` — write-before-token ordering *(closes G3)*
- `[x]` `/api/invite-agent` — §14.1 prompt, agora_vad 300ms, tools schema attached
- `[x]` `/api/agent-events` — event 104 renewal, signature-verified
- `[x]` `/api/health` — credential preflight
- `[x]` Roster Service with multi-user sequential UID allocation
- `[x]` Trust-zone boundary enforced by `server-only` + tests
- `[x]` Agora credentials verified LIVE — token mints, Conversational AI enabled
- `[x]` Fast Loop cascaded on Groq `gpt-oss-120b` + MiniMax/ElevenLabs TTS
- `[x]` Tool definitions wire payload fix: `agent._llm["tools"]` attached directly
- `[x]` Live RTM transcript path integrated directly into the console


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
- `[~]` **`rti.py`** — **REMOVED Sep 8.** Built as specified (normalized, EWMA,
  Schmitt hysteresis, 90s cooldown) but it never had a producer: the index needs
  one 200ms slice of per-UID RMS and F0 per participant, which only the native
  Agora server SDK supplies — and that is the S2 blocker below. Nothing in the
  repo ever posted to `/rti/observe`. Deleted with its route, its test, and
  `utterance.tension_intervention`. `Ledger.rti` stays at `0.0` so the console's
  wire contract is untouched. **G5 is now open again** — reintroduce only with a
  producer written first.
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

## S3 / S4 — Epistemic Engine & Contradiction Detection — ✅ COMPLETE & VERIFIED
- `[x]` Evidence Ledger aggregate root with strict epistemic status: `OBSERVED`, `TOOL_RESULT`, `HYPOTHESIS`, `INFERRED`
- `[x]` Two-stage contradiction detection: candidate scoping (same entity, 30 min window) -> candidate retrieval -> deliberation
- `[x]` **Qdrant Dense Vector Embeddings**: 384-dimensional dense vectors + cosine similarity blended with lexical Jaccard
- `[x]` Deliberation Panel (§7a): Skeptic (bias against) vs Seeker (bias for) + Referee split resolution
- `[x]` Anti-causal tripwires in `utterance.py` and `telemetry.py` enforce Rule 1 structurally
- `[x]` Hypothesis Elimination Matrix: cross-references hypotheses with empirical telemetry to refute false rabbit holes

## S5 — Bridge Integration & Authorization Gate — ✅ COMPLETE & VERIFIED
- `[x]` Bridge Controller (`agora_bridge.py`): `/speak` + `/interrupt`, priority discipline, 12s interruption floor
- `[x]` `INFERRED` filter in the Bridge Controller: structural guarantee that inferred claims never reach voice
- `[x]` Two-Channel Authorization Gate: nonce + TTL + argsHash + role-bound gate
- `[x]` Live verification: verbal "yes, approved" denied authorization; wrong role rejected; dashboard click required
- `[x]` Consent Gate (§10.5): "off the record" stops ingestion immediately, counts dropped turns without storing content

## S6 — Persistence, Infrastructure & Verification — ✅ COMPLETE & VERIFIED
- `[x]` Rehearsal Rig Tier 1 (Frontend, 172 tests), Tier 2 (Backend, 334 tests), Tier 3 (live end-to-end rehearsal)
- `[x]` Redis 7 Streams: `echosphere:deltas` and `echosphere:claims` streaming bus with distributed atomic locks
- `[x]` Qdrant Vector DB: containerized semantic memory with payload channel filtering and reset purge
- `[x]` Dual-tier persistence: PostgreSQL 16 on port 5434 with in-process SQLite WAL fallback
- `[x]` Automated Postmortems: generation of structured postmortem reports and markdown exports
- `[x]` Multi-channel / multi-project isolation


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
