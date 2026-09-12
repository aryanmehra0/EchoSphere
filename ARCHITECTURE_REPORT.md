# EchoSphere — Codebase Architecture Report

Grounded entirely in the current source tree (`backend/app/`, `frontend/src/`) as of this
report's writing — not in `docs/`, which may not reflect the code as it stands today.
File:line references point at load-bearing logic worth re-reading directly.

---

## 1. What the code says this product is

Inferred from the domain model itself, not from marketing copy: this is a **live incident
war-room console** with a voice AI ("Echo") sitting on the call. The single clearest signal
of intent is the `epistemic_status` field on every `Claim`
(`backend/app/domain/models.py`): `OBSERVED | TOOL_RESULT | HYPOTHESIS | INFERRED`, and the
fact that `INFERRED` claims are structurally excluded from speech and from any prompt fed
back to an LLM. The system is built to **record and organize what is said and measured**,
never to assert a diagnosis. That is not a stray feature — it is the organizing constraint
the rest of the architecture is built to enforce mechanically.

---

## 2. Domain model (`backend/app/domain/`)

### The Ledger — the aggregate root

`Ledger` (`app/domain/ledger.py`, aliased `EvidenceLedger`) is the single record of one
incident: `entities`, `links`, `claims`, `unchecked`, `tasks`, `contradictions`, `timeline`,
plus `incident_id`, `phase`, `channel`, `rti`.

Notable behavior, not just structure:

- **Merge, never replace.** `upsert_entity` merges fields; a later extraction window that
  doesn't mention a metric must not blank it. Aliases accumulate rather than overwrite.
  Silence is not treated as an update — only an actual new value can change a field.
- **`upsert_claim` dedupes within one speaker**, never across speakers — two different
  people asserting the same thing is corroboration, not a duplicate. If a statement exists
  once as fact and once as hypothesis, the more cautious status wins.
- **`query(scope, entity)`** is a deterministic read with no LLM in the path — this is what
  makes "ask the same question twice, get the same answer" a structural guarantee.
- **`recap()`** excludes `INFERRED` claims by construction — a model's own guesses are never
  fed back into a future prompt as if established fact.

### The models

`Claim`, `Entity`, `Link`, `Task`, `TimelineEvent`, `Contradiction`, `Transcript`,
`Unchecked` — all plain dataclasses, deliberately mirrored field-for-field by
`frontend/src/lib/types.ts` (no adapter layer; the delta hub serializes these straight onto
the socket). `Claim.__post_init__` raises `ValueError` if `speaker_role` is missing — an
unattributed claim cannot be constructed, not just discouraged.

Every enum/list field goes through defensive coercion (`coerce()`,
`coerce_str_list()`) because the wire is fed by an LLM that can emit an invalid `kind` or a
bare string where a list was expected — either would otherwise crash the frontend.

### Policies vs. services (`app/domain/policies/`, `app/domain/services/`)

- **Policies** (`authorization.py`, `contradiction.py`, `degradation.py`, `privacy.py`,
  `proxy.py`, `reconciliation.py`, `redaction.py`, `utterance.py`) are gates: given some
  input, do they allow it, and in what transformed/validated form. Stateless or
  narrowly-stateful rule enforcement.
- **Services** (`telemetry.py`, `elimination.py`, `projects.py`) actively compute and
  produce new domain objects — a telemetry probe manufactures a `Claim`; the hypothesis
  matrix service mutates claim lifecycle state (marking hypotheses `REFUTED`).

### Reconciliation — why entity IDs don't fragment

The extraction LLM proposes entity IDs per window with no memory of the ledger. Without
correction, "Redis", "the cache", and "redis-1" spoken across three windows would fork into
three separate graph nodes — and since the contradiction engine scopes candidate pairs by
matching entity ID, this **silently disables contradiction detection** (a real, documented
failure mode). `EntityReconciler` (`app/domain/policies/reconciliation.py`) fixes this
deterministically in code: known aliases win over fresh proposals, vague placeholder IDs
like `database-unspecified` get promoted to concrete IDs once a later utterance names the
system — guarded by a `VagueNounPolicy` frozenset so generic words never themselves become
fake distinct systems.

### Rule 1 enforcement — defense in depth, not a single gate

Non-causal, attributed-only claims are enforced independently at **four separate layers**:

1. Type-level: `Claim` cannot be constructed without `speaker_role`.
2. `app/domain/policies/utterance.py`: every sentence Echo speaks is composed in Python
   (not generated freely by an LLM) and passed through `validate()`, which regex-checks for
   causal phrasing and for attribution before the sentence is allowed to exist. A failure
   raises `EpistemicViolation` rather than shipping.
3. `app/domain/services/telemetry.py`: `synthesize_claim()` raises `ValueError` if a
   telemetry-derived claim's text contains causal language — a second, independent
   tripwire.
4. `app/domain/services/elimination.py`: reuses the same causal regex to scrub its own
   generated reasoning text before it's surfaced.

The pattern across the codebase: when a specific incident happened live, the fix was
encoded as a structural guarantee (a raise, a type constraint, a merge rule) — not a comment
asking future developers to be careful.

---

## 3. Layering (hexagonal / DDD)

```
app/domain/          pure rules & models — Ledger, Claim/Entity/Contradiction, policies, services
app/application/     orchestration — the extraction pipeline, the session registry, ports
app/infrastructure/  adapters — SQLite/Postgres store, Agora, Groq/Gemma, config
app/web/             FastAPI routers, middleware, deps (the driving adapter)
```

Verified dependency direction (not just asserted): `domain/` is imported by everyone and
mostly does not import outward, with two acknowledged exceptions — `ledger.py` imports
`infrastructure/store` directly (persistence as a side effect of every mutation, pragmatic
rather than fully inverted), and `contradiction.py` lazily imports an `application/`
deliberation service to avoid a circular import, flagged in-code as a known layering
wrinkle. `web/` depends on `application/` via `deps.py` and is never imported back — routers
can't import `main.py` either, since `main` imports the routers.

`app/__init__.py` registers `sys.modules` aliases so an older flat layout
(`app.core`, `app.adapters`, `app.services`, `app.routers`) still resolves after the
rename — a deliberate compatibility shim, not duplicated code.

---

## 4. Persistence & event sourcing

Two layers, deliberately asymmetric in guarantee:

1. **SQLite WAL event store** (`app/infrastructure/event_store.py`) — always on, zero
   external dependency. An append-only `incident_events` table (the true log) plus an
   `incident_snapshots` table upserted alongside every event (materialized current state,
   O(1) rehydration without replaying history).
2. **Postgres**, via `asyncpg` — optional, best-effort, write-behind. Fired via
   `asyncio.create_task`; failures are logged, never raised. The in-memory Ledger stays the
   source of truth for latency-critical reads (the live transcript endpoint, Agora's
   synchronous tool queries) — a DB hiccup must never stall someone mid-sentence.

Load path tries Postgres first, falls back to SQLite — SQLite is the guaranteed floor,
Postgres a mirror. Column lists are derived from `dataclasses.fields()` rather than
hand-maintained per-model, after a real incident where a `list[str]` field was omitted from
a hand-kept JSON-columns set and silently failed to persist.

Two rehydration paths exist: `Ledger.restore()` (async, via `store.load()`, tolerant of
schema drift) and `Ledger.rehydrate_from_snapshot()` (synchronous, reads SQLite snapshots
directly, runs on every `IncidentSession` construction, normalizes camelCase wire keys back
to snake_case). Session construction also replays event history purely to recover the max
`seq` so a post-restart delta stream continues numbering rather than resetting to 0.

**Not persisted, deliberately**: the contradiction engine's cooldown timestamps, the
in-flight `TurnWindow` buffer, live WebSocket subscriber connections, in-flight asyncio
tasks, the live Agora agent handle, and any raw-text/PII redaction mapping — the last is a
requirement, not an oversight: transcripts and derived identifying data are session-scoped
and purged, not retained.

---

## 5. Session lifecycle (`app/application/services/session.py`)

`IncidentSession` bundles everything scoped to one incident: `ledger`, `hub` (delta
fan-out), `window` (transcript batching), `engine` (contradiction detection),
`proxy`/`privacy` (governance gates), `degraded` (operator-facing health state), the live
Agora `agent` handle, a `pipeline_lock`, and `pipeline_tasks`.

`SessionRegistry` keys sessions by channel. `/incident/reset` constructs a fresh
`IncidentSession` rather than mutating the old one in place — any still-running background
pipeline task from the old session is explicitly cancelled, and the old session is kept in
a short-lived "retired" list rather than dropped outright, because task cancellation isn't
instantaneous. `total_in_flight` sums live + retired sessions specifically so a caller
checking "is analysis still running" doesn't undercount a straggler task mid-cancellation.
A reset also constructs a fresh privacy gate — a new incident always starts on the record.

Today every route resolves against one default channel — one incident bridge at a time is
the current product shape, though the registry itself is keyed generically enough that a
second concurrent incident would be a routing change, not a rewrite.

---

## 6. Real-time pipeline: mic to dashboard

**Ingress** (`app/web/routers/ingest.py`, `POST /observer/transcript` — the only way in):

1. Self-exclusion: frames from Echo's own agent UIDs are dropped immediately, or Echo's own
   speech would loop back as a human claim and could trigger a contradiction against itself.
2. An unattributed UID with no role is dropped and logged — never guessed at.
3. Privacy/consent gate runs **before** redaction or storage — an "off the record" phrase
   discards the utterance entirely, not just from claims but from any log.
4. Redaction runs at the door, before storage or windowing — moving it later once let a
   spoken credential get transcribed, persisted, and read back aloud when asked about it.
5. The transcript is added to a `TurnWindow` (dedup by `message_id`, only final frames
   accepted), persisted, and published to dashboards immediately — separately and faster
   than claim extraction, so words appear live rather than after analysis completes.
6. The pipeline is spawned as a background task, not awaited — awaiting inline would tie
   the HTTP response latency to full extraction+contradiction runtime (documented up to
   60s under LLM rate-limit backoff), stalling every subsequent transcript mid-incident.

**The window flush rule** (`app/application/services/extraction.py`): a `TurnWindow`
flushes on whichever comes first — 1.5s of silence after the last final frame, 8s elapsed,
or 1600 characters accumulated. Because nothing else observes "silence" (no new frame
arrives to notice a gap), a background ticker in `main.py` calls the flush check every 0.5s
— this is what actually makes the silence rule fire in real time.

**Extraction → Claims**: window text plus a "Compacted State" (recent established facts,
all open tasks/contradictions/entities — obligations are never dropped, color can be) is
sent to Groq (default) or Gemma, requesting a strict JSON schema. Post-processing is
code-enforced, not model-trusted: hedged language is structurally downgraded to
`HYPOTHESIS` with confidence capped regardless of what the model claimed; near-duplicate
claims are merged; entity IDs are reconciled (§2); causal-labeled links are stripped even if
the model marked them `depends`/`suspected`.

**Delivery** (`app/infrastructure/deltas.py`, `/ws/deltas`): a client sends `HELLO` with its
last known `seq`. If the gap fits inside a 500-entry ring buffer, the server replays exactly
those envelopes; if the gap is too large, it falls back to a fresh snapshot. Every delta
carries a monotonic sequence number; a client with a full queue is dropped and reconnects
rather than backpressuring the whole analytics pipeline. `DeltaHub.adopt()` is what lets an
`/incident/reset` swap in a new hub without silently orphaning already-connected dashboards.

**Contradiction handling**: adjudicated by a domain policy that may (per the domain-layer
research) escalate to a multi-persona deliberation service; a confirmed contradiction is
recorded, published as a delta, and — if a voice agent is live — spoken through the same
`utterance.validate()` gate as everything else Echo says.

---

## 7. Tool-calling surface & tunnel dependency

`app/web/routers/tools.py` exposes what Agora's Conversational AI can call **from Agora's
own cloud infrastructure**, not from the browser:

- `POST /tools/query_incident_state` — a pure deterministic ledger read, no LLM in the
  path.
- `POST /tools/probe_telemetry` — a read-only synthetic telemetry probe; the resulting
  claim is upserted and published live.
- `POST /tools/invoke` — the general action-execution path, routed through an authorization
  policy; risk classification is a property of the action itself (not the request), so a
  prompt injection can't talk its way into treating a dangerous action as harmless.

Because these are called from Agora's servers, the backend must be reachable on the public
internet — hence the Cloudflare tunnel. Exposing the whole service that way (not just the
tool endpoints) is why `app/web/middleware.py` exists: local requests pass through
untouched; public/tunnel requests are rate-limited, size-capped, and — outside a short
allow-list of public/browser-facing paths — must present either a shared secret header or
an HMAC signature (with a 300-second replay window) or are rejected. No secret configured
means every remote request is refused, fail-closed.

---

## 8. Frontend architecture

**Single state container** (`frontend/src/lib/incident-store.tsx` +
`incident-reducer.ts`): one `IncidentState`, one `IncidentProvider` at the root, one pure
reducer handling `SNAPSHOT` (full replace of server-owned collections), `DELTA` (incremental
upsert-by-id merge — idempotent, so a replayed delta is a safe no-op), `TRANSCRIPT`
(dedup + partial/final handling), `BRIDGE`/`AGENT` (transport state), and others. Both the
real delta socket and a scripted demo replay dispatch the **same action shapes into the
same reducer** — no component can distinguish live data from rehearsal data; only a `source`
field surfaces that distinction in the status bar. Demo replay is opt-in
(`NEXT_PUBLIC_DEMO_REPLAY=1`) rather than an automatic fallback, after a case where an
unreachable backend on a shared tunnel caused every guest to silently watch a fabricated
incident.

**`delta-socket.ts`** is the single confined point of network egress from the browser
(enforced by a test asserting no other client module opens a raw fetch/WebSocket) — the
WebSocket client with its own reconnect/backoff ladder and connect-timeout watchdog (guards
against a socket stuck mid-handshake against a tunnel/proxy that never upgrades, which
otherwise produces no error event at all and stalls the console indefinitely), plus every
REST helper (roster, bridge credentials, agent lifecycle, telemetry probes, projects).

**Voice layer** (`agora-bridge.ts`, `agora/voice-agent.ts`): joins the Agora RTC channel,
auto-subscribes to every publisher, special-cases Echo's fixed UID for the voice-envelope
visualization, and holds each utterance in a settling buffer until its text stabilizes
before forwarding it once — the toolkit re-emits growing transcript arrays on every update,
and downstream extraction needs each finished sentence exactly once.

**Component structure**: `IncidentConsole.tsx` is a fixed three-column, non-scrolling
layout (Voice / Graph / Intel) — deliberate, so information stays in a consistent physical
location under pressure. `GraphCanvas.tsx` renders the topology read-only from
`state.entities`/`state.links` (dragging changes layout, never topology — "if an operator
can drag an edge onto it by hand, it stops being evidence"). `LedgerPanel.tsx` visually
separates Established / Open Hypotheses / Inferences from one underlying claims array.
`TheoriesPanel.tsx` renders a hypothesis-elimination projection that cross-references open
theories against telemetry claims to classify them refuted/corroborated/open, with a
one-click probe action — never declaring an overall winner.

**RBAC**: `UserPermission` (enterprise-level authority) and `ParticipantRole` (bridge-role
identity) are distinct axes. A gated action like approving a critical action checks
**either** — the authenticated user's permission grants it, or their currently-assumed
bridge role is privileged enough — and voice-based "yes, approved" is explicitly demoted to
an intent signal, not authorization; the actual approval is a separate, TTL-bound,
authenticated redemption.

---

## 9. Verified current state (as of this report)

- Backend imports and boots cleanly; the full test suite (`backend/tests/`) passes: **326
  tests**, all green, most recently including 15 new tests for the Projects feature
  (`backend/tests/test_projects.py`), which was previously an unimplemented stub blocking
  startup entirely and has now been implemented (in-memory `ProjectsService` + router:
  list/get workspaces, save/probe connectors, create incidents).
- Frontend type-checks cleanly (`tsc --noEmit`) with no errors.
- Bridges (voice channels) are currently free-standing — any channel name typed in
  `BridgeControls.tsx` can be joined/created; there is no backend enforcement linking a
  Project to a bridge yet, even though the frontend has a fully-built `ProjectWorkspaceModal`
  UI for that flow. Role exclusivity per bridge is opt-in (a `body.exclusive` flag not
  currently sent by the UI) — multiple people can currently share a role on a bridge by
  design of the shipped frontend.
- The backend requires a public tunnel (`start.ps1 -Tunnel`) for Echo to have read access to
  the incident Ledger via tool-calling; without it, Echo can hear and speak but cannot
  answer questions about the incident, by design (it refuses to answer from unattributed
  memory rather than guess).

---

## 10. Where the architecture itself suggests future work

Not from docs — inferred directly from code seams and explicit in-code acknowledgments:

- **Projects ↔ Incidents is not wired end-to-end.** The domain has no concept of a project
  at the Ledger level at all (`Ledger` is single-incident, single-channel, no project
  field), and the bridge join path (`BridgeJoinOptions`) never carries a `projectId`. If the
  intended flow is "project → team → spun-up war room," that link needs building in the
  domain layer, not just the UI.
- **`contradiction.py`'s lazy import of an application-layer deliberation service** is a
  flagged, acknowledged layering wrinkle (domain reaching into application) — worth
  revisiting if the hexagonal boundary matters for future maintainability.
- **Postgres writes are fire-and-forget** (`asyncio.create_task`, failures logged only) —
  acceptable for a live-bridge availability tradeoff, but means recent writes can be lost on
  an ungraceful restart; worth deciding if that's still the right tradeoff outside a demo
  context.
- **One default channel per process** — the session registry is keyed generically enough to
  support concurrent incidents, but nothing currently exercises that path; multi-incident
  support would need routing changes plus verification, not a rewrite.
- **The reconciliation and redaction regex/heuristic layers** are doing real semantic work
  (vague-noun detection, causal-language tripwires, PII pattern matching) with no
  ML/embedding assist — fine for a bounded demo vocabulary, but worth stress-testing against
  more varied real speech patterns before relying on it broadly.
