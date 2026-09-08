# EchoSphere — Architecture (Current State)

This is a concise, code-accurate map of the system as it exists in this
repository today. It is derived by reading the running source, not by
restating intent. For the full design rationale, the nine gaps it closed, and
workflow-by-workflow detail, see `docs/echosphere_architecture_v6.md` — that
document stays the source of truth for *why*; this one is the source of truth
for *what is currently wired up, where*.

---

## 1. What this is

Echo is a voice-based AI participant that joins a live incident bridge,
listens, and keeps a structured, attributed record of what was said —
without ever asserting a root cause. It is a two-service system plus a
third-party managed voice AI platform:

- **`frontend/`** — Next.js 16 / React 19 console. Serves the dashboard and
  holds all secrets that talk to Agora.
- **`backend/`** — Python / FastAPI service. Owns the incident record,
  runs analysis, and is the only thing allowed to put words in Echo's mouth.
- **Agora Conversational AI Engine** — a cloud-hosted voice agent (ASR → LLM
  → TTS) that is a real participant in the call. It does not think about the
  incident; it talks, and asks the backend when it needs facts.

## 2. The three zones

| Zone | Where | Holds | Never does |
|---|---|---|---|
| **Zone 1** — Browser | `frontend/src/components/**` | UI state via one reducer | Never sees Agora credentials |
| **Zone 2** — Next.js server | `frontend/src/lib/server/**`, `frontend/src/app/api/**` | Agora App ID/Certificate, Customer ID/Secret, token minting | Never analyzes incident content |
| **Zone 3** — Python service | `backend/app/**` | Groq key(s), the Ledger, all analysis | Never speaks directly to the room |

Zone 2 and Zone 3 are marked `server-only` / enforced by tests
(`frontend/AGENTS.md`, rule 4) — client code cannot import them, so a secret
leak into the browser bundle fails the build rather than shipping.

## 3. The two loops (the core design decision)

```
 FAST LOOP  (talks, budget ~1.5s)              SLOW LOOP  (thinks, budget ~4s)
 ─────────────────────────────────             ──────────────────────────────
 Agora Cloud Agent (managed process)            backend/app/main.py (FastAPI)

  mic audio → Deepgram ASR → LLM → TTS           transcript → window → extract
      (nova-3)      (Groq or        (ElevenLabs      → Ledger → contradiction
                   gpt-4o-mini)      / Sarvam)          engine → Bridge → /speak

  reads facts via  ───────────────────────────►  POST /tools/query_incident_state
  (REST tool call, Fast → Slow, no LLM in path — deterministic read)

  is told what to say ◄─────────────────────────  BridgeController.speak()/speak_now()
  (POST /agents/{id}/speak on Agora's own agent-control API)
```

**The invariant, enforced structurally, not just by prompt:**
the Fast Loop never writes to the Ledger, and the Slow Loop never speaks
except through `backend/app/utterance.py`, which composes and validates
every sentence before `adapters/agora_bridge.py` is allowed to send it.

- Fast Loop system prompt: `frontend/src/lib/server/agent-config.ts:29-79`
  — defines Echo's identity, the 4 epistemic rules, and when it's allowed to
  speak at all (default: silence).
- Slow Loop ingestion pipeline: `backend/app/services/pipeline.py`
  (`run_if_ready`) — window → redact → extract → merge into Ledger →
  publish delta → check for contradictions → maybe speak.

### Backend layering

Three layers, and one rule that keeps them honest: **routes do no work,
services own no transport.**

| Layer | Directory | Imports FastAPI? | Makes network calls? |
|---|---|---|---|
| Transport | `app/routers/`, `app/middleware.py` | yes | no |
| Orchestration | `app/services/` | **no** | no |
| Domain | `app/*.py` (ledger, extraction, panel, …) | no | no |
| Adapters | `app/adapters/` | no | **yes** |

`app/main.py` is an app factory only (~110 lines): lifespan, CORS, middleware,
router registration. `app/deps.py` holds the two process-scoped things routers
need — the pooled HTTP client and the session lookup — so routers never import
`main` and the cycle cannot form.

## 4. Request/data flow, end to end

```
 Browser mic
     │ RTC audio
     ▼
 Agora SD-RTN ──► Agora Cloud Agent (ASR/LLM/TTS)
     │                    │
     │ RTM data channel   │ tool webhook (needs a public URL — see §6)
     │ (transcripts)      ▼
     │             POST backend /tools/query_incident_state
     ▼                    (reads the Ledger, answers, no LLM call)
 Next.js console
   (renders transcripts as they arrive)
     │
     │ forwards role-attributed text
     ▼
 POST backend /observer/transcript
     │
     ├─ privacy gate (off-the-record check)   backend/app/privacy.py
     ├─ redaction                             backend/app/redaction.py
     ├─ TurnWindow batching (1.5s silence rule, or 8 frames)
     ▼
 services/pipeline.run_if_ready()
     ├─ extract() → Groq LLM → claims/entities/links/tasks/timeline rows
     ├─ merge into Ledger (dedupe entities by alias, upsert everything)
     ├─ hub.publish(delta) ──────► WebSocket /ws/deltas ──► every dashboard
     └─ ContradictionEngine.evaluate() over new claims
              scope (same entity, 30 min) → retrieve (lexical overlap)
              → cooldown (5 min) → adjudicate (Deliberation Panel, 2 biased
                LLM personas + referee, on Groq)
              if OPPOSED (or best available verdict):
                  → utterance.contradiction_intervention() (Rule checks)
                  → BridgeController.speak_now()
                  → Agora /agents/{id}/speak → TTS → audio in the room
```

## 5. The Ledger — the single source of truth

`backend/app/ledger.py` holds the live incident state in memory (optionally
mirrored to Postgres, see §7). Its shape is defined once and mirrored
field-for-field on both sides of the wire:

- `backend/app/models.py` (Python dataclasses)
- `frontend/src/lib/types.ts` (TypeScript types)

Core record types: `Claim`, `Entity`, `Link`, `Task`, `Unchecked`,
`Contradiction`, `TimelineEvent`, `Transcript`.

The load-bearing field is `Claim.epistemic_status`:
`OBSERVED | TOOL_RESULT | HYPOTHESIS | INFERRED` (`models.py:16`). This is
what turns "is this fact or assumption?" into a queryable field instead of a
convention. `Claim.speaker_role` is mandatory — the dataclass raises in
`__post_init__` if it's missing (`models.py:98-103`), because an unattributed
claim is not allowed to exist, let alone be spoken.

All incident-affecting endpoints publish through `DeltaHub`
(`backend/app/deltas.py`), which assigns each change a monotonic `seq` and
keeps a replay ring buffer. The frontend's `incident-reducer.ts` is the only
place UI state is mutated — it merges deltas by id, so replays and
reconnects are naturally idempotent (`frontend/src/lib/incident-reducer.ts`).

## 6. The Bridge — how the two loops actually talk

Three channels, all in `backend/app/adapters/agora_bridge.py`:

1. **QUERY** (Fast → Slow): `POST /tools/query_incident_state`. Deterministic
   read, no LLM — same question asked 8 times returns 8 identical answers.
2. **PUSH** (Slow → Fast): `BridgeController.speak()` /
   `speak_now()` call Agora's own `/agents/{id}/speak` and
   `/agents/{id}/interrupt` REST endpoints — the Slow Loop puts exact words
   in Echo's mouth; the Fast Loop's own LLM never composes what gets spoken
   proactively.
3. **BEACON** — a Ledger recap is appended to the system prompt on
   (re)join so a freshly created agent doesn't start blind
   (`_with_recap`, `routers/agent.py`).

Every proactive utterance goes through `services/speech.py`, which is the only
caller of the Bridge and the only writer of the voice-degradation banner — so
a failed `/speak` can never leave the dashboard claiming voice is healthy.

Because Agora's Engine calls tool endpoints **from Agora's own servers**,
the backend must be publicly reachable — `start.ps1 -Tunnel` opens a
Cloudflare quick tunnel for this. Everything reachable over that tunnel
except `/health`, `/observer/transcript`, and `/ws/deltas` is gated behind
an `AGENT_TOOL_SECRET` bearer check that fails closed
(`app/middleware.py`, the `tunnel_gate`).

## 7. Persistence

- **Primary store: in-memory**, on the `IncidentSession` held by
  `services/session.py`. `/incident/reset` replaces the whole session rather
  than clearing fields one by one, so anything incident-scoped is reset by
  construction and nothing has to remember to do it.
- **Optional durability: Postgres 16**, containerized by the root
  `docker-compose.yml`. `backend/db/schema.sql` defines tables for claims,
  entities, links, tasks, contradictions, timeline, and transcripts, all
  keyed by `(channel, id)`. `store.connect()` never raises — a machine with
  no Docker still runs the bridge, degraded to in-memory only, and that
  degradation is reported via `/health`, never silently assumed.
- **No message queue.** Fan-out to dashboards is an in-process asyncio
  pub/sub (`DeltaHub`); pipeline serialization is one `asyncio.Lock` per
  session so a background flush ticker and an incoming transcript can't
  double-extract the same window.

Two subtleties the session boundary introduced, both load-bearing:

- **`DeltaHub.adopt`** — connected dashboards hold a queue from the *old*
  hub, so a reset hands those subscribers to the new session's hub. Without
  it every open board would receive the clearing snapshot and then go
  permanently silent.
- **`registry.total_in_flight`** — `/health` reports analyses running across
  *all* sessions, retired ones included. A pipeline task spawned just before
  a reset keeps running against the old session; counting only the current
  one made `pipeline.inFlight` read 0 while an extraction was still
  in flight, and Rig Tier 3 sampled early. Reset now also cancels that work,
  since a reset means the incident is over.

## 8. Security-relevant mechanisms

- **Authorization Gate** (`backend/app/authorization.py`, `proxy.py`) —
  CRITICAL tool actions (e.g. `execute_runbook_script`) go through a
  nonce + TTL-bound approval that only a dashboard click from an authorized
  role can redeem. Voice can log *intent* (`/approval/verbal`) but that path
  never reaches redemption — classification is a property of the action
  itself, so a prompt injection can't talk Echo into skipping the gate.
- **Privacy / consent gate** (`backend/app/privacy.py`) — "off the record"
  stops ingestion before redaction, before extraction, before the transcript
  reaches any dashboard. Suspended turns are counted, never stored.
- **Epistemic enforcement** is layered, not just prompted:
  1. Prompt-level rules (`agent-config.ts:33-44`)
  2. `utterance.py` — every sentence the Slow Loop wants Echo to say is
     composed and validated here; raises `EpistemicViolation` rather than
     letting a diagnosing sentence through.
  3. `BridgeController.strip_inferred()` — a structural filter: an
     `INFERRED` claim can never reach the voice channel, independent of
     what any prompt says.

## 9. Removed: the Room Tension Index

The v6 design specifies an RTI subsystem (§8) that scores room tension from
per-participant volume spread, pitch deviation and speech overlap, and lets Echo
intervene with a de-escalating re-grounding in the record. It was built and
unit-tested, and **it was deleted on 2026-09-08 because it had no producer.**

Computing the index requires one 200 ms slice of per-UID RMS and F0 per speaker.
That is only obtainable from the native Agora Python server SDK — the same
dependency the Observer is blocked on (§10). Nothing in the repository ever
posted to `POST /rti/observe`: not the console, not the demo scripts, not any
Rehearsal Rig tier, not `validate.ps1`. The dashboard's tension meter read
`state.rti`, and that value was always the reducer's initial `0`.

What remains deliberately: `Ledger.rti` and the `rti` key in the delta snapshot,
both fixed at `0.0`. `frontend/src/lib/types.ts` still declares the field and the
console still reads it, so the wire contract is unchanged. Reintroducing the
index means writing the producer first.

## 10. Known architectural compromise

The Observer (per-speaker audio ingestion) is specified in the v6 doc as a
direct per-UID PCM tap via the Agora Python Server SDK
(`on_playback_audio_frame_before_mixing`), but that SDK has no wheel for
Python 3.14. The actual implementation today is an **HTTP adapter seam**:
`POST /observer/transcript` accepts role-attributed text from whatever
produces it (currently Agora's RTM transcript stream, forwarded by the
browser). Everything downstream — window, extract, Ledger, contradiction,
Bridge — is identical either way, and this seam is also what makes the
Rehearsal Rig's synthetic-transcript tests exercise the real pipeline
(`backend/rig/`).

## 10. Where to look for more

| Question | File |
|---|---|
| Why this shape, what it replaced, full workflow specs | `docs/echosphere_architecture_v6.md` |
| Exact wire contract | `backend/app/models.py`, `frontend/src/lib/types.ts` |
| Everything Echo is allowed to say | `backend/app/utterance.py` |
| The contradiction adjudication algorithm | `backend/app/contradiction.py`, `backend/app/panel.py` |
| Fast Loop prompt (the actual behavior contract) | `frontend/src/lib/server/agent-config.ts` |
| All state-changing HTTP/WS surface | `backend/app/routers/` |
| The routes the frontend depends on | `backend/tests/test_contract.py` |
| UI state machine | `frontend/src/lib/incident-reducer.ts` |
| Cross-session decisions and dead ends | `docs/session_log.md` |
