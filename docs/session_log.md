# 🧠 Session Context Log — EchoSphere

> **Purpose.** This file is the memory that survives between chat sessions.
> Code and git history record *what* exists. This records *why* — the decisions,
> the dead ends, the corrections, and the things a fresh agent would otherwise
> re-derive or re-break.
>
> **If you are an agent or developer starting a new session: read this file
> first, then `echosphere_architecture_v6.md`, then `handoff_log.md`.**
>
> **Last updated:** August 27, 2026

---

## 1. Where we are right now

| | |
|---|---|
| **Governing architecture** | `docs/echosphere_architecture_v6.md` (v6 supersedes v5) |
| **Branch** | `main` — clean, everything pushed |
| **Last commit** | `a5e29a9` feat(s1): Fast Loop identity layer |
| **Phase 1 (console UI)** | ✅ Done, v6-aligned |
| **S1 (identity layer)** | 🟡 Server code done and tested — never run against live Agora |
| **S0 (Bridge Spike)** | ⬜ Script written, **not yet run** |
| **Tests** | 72 passing (`npm run verify`) |

### 🚧 THE ONE BLOCKER

**`frontend/.env.local` exists but is empty.** Five values are needed. Until
they are filled in, nothing can reach Agora — no S0, no S1 live test.

Verify status any time (do not read the file, it holds secrets):

```bash
curl localhost:3000/api/health     # want {"ready":true,...}
```

As of this writing: all five `false`.

### The immediate next step

```bash
cd frontend
# 1. fill in .env.local  (5 values — see §6 for where each comes from)
curl localhost:3000/api/health          # must say ready:true
npm run spike -- --channel inc-spike    # S0 — DO THIS BEFORE S1 WIRING
```

**Do not skip S0.** v6 §17 moved it first deliberately. It proves the Bridge
works in both directions. If it fails, the architecture needs rescoping — and
you want to learn that with two weeks left, not the night before submission.

---

## 2. Session history

### Session 1 — Phase 1 rebuild (Aug 25)

**Ask:** "check the docs, re-iterate Phase 1, make it best-of-best. We don't
need an AI-type website — make it show 20 years of design experience."

**What existed:** a three-file scaffold (`page.tsx`, `GraphVisualizer`,
`VoiceRoom`) with mock data hardcoded inside a component. `globals.css`
literally had `font-family: Arial`.

**What was done:** rebuilt Phase 1 end to end — ~20 files, design system, typed
data contract, test suite. See §3 for the design decisions and §4 for the
architecture.

**How bugs were found:** by driving the running app through the full demo via
Chrome DevTools Protocol and screenshotting it. That caught four defects that
typecheck, lint and build all passed:

1. Edge labels clipped behind nodes (52px gap, ~110px label)
2. Edges routed back *through* their own source card
3. Every timestamp rendered `05:30` — fixture offsets fed to a wall-clock
   formatter (`new Date(4400)` → 1970 + IST)
4. `fitView` zoomed to ~0.6, node text unprojectable

> **Lesson worth keeping:** a green build says nothing about whether the UI
> works. Screenshot the running app.

### Session 2 — v6 alignment (Aug 25)

**Ask:** "read `EchoSphere_Architecture_v6.pdf`, check if Phase 1 is good
according to it."

PDF rendering was unavailable (no poppler); extracted the text with PyMuPDF
instead. `docs/echosphere_architecture_v6.md` is the same document.

**Verdict: structurally right, epistemically wrong.**

v6 §4.6 "Frontend architecture — as built" describes and *ratifies* the Phase 1
structure. Three choices turned out to be load-bearing v6 requirements: the
pure reducer, dedup living in the reducer, and idempotent merge-by-id (§9.3
calls it "already true of the Phase 1 reducer").

But the **content** failed on v6's central point. The demo replay contained
both Echo lines that v6 §6.3 tabulates as violating the brief:

| Was in `mock-stream.ts` | v6 verdict |
|---|---|
| "That points to a network partition… rather than a cache failure" | violates |
| "VPC flow logs confirm… The primary Redis node is isolated" | violates |
| "Root cause: network partition in us-east-1a" | must be "root cause is **not** established" |

I had built the fact/assumption *container* correctly and filled it with v5's
diagnosing-AI dialogue. Fixed by rewriting to Demo Script v2 (§18) and adding
regex tripwires that fail the build if diagnosing language returns.

### Session 3 — commit & push (Aug 25)

Three commits on branch `phase-1-console-v6`, pushed. User merged as PR #1.

Note: `echosphere_master_context.md` showed 145 insertions / 122 deletions —
that was an **editor formatting pass by the user**, not a content change.

### Session 4 — S1 identity layer (Aug 26)

Built `/api/token`, `/api/invite-agent`, `/api/agent-events`, `/api/health`,
plus the Roster and agent config. 72 tests. Commit `a5e29a9`, pushed to `main`.

### Session 5 — Agora console setup (Aug 26–27)

Console walkthrough. Decisions recorded in §6.

---

## 3. Design decisions (Phase 1 UI)

**The brief was "not an AI-type website."** The chosen language is a
**mission-control console** — Bloomberg Terminal, air-traffic control, IBM
Carbon.

Removed the "AI product" tells: indigo gradient buttons, backdrop-blur glass
panels, `rounded-xl`, and the Arial fallback.

| Decision | Why |
|---|---|
| Graphite ramp, never pure black | `#000` crushes hairlines, blooms on projectors |
| 3 hairline weights, **no glassmorphism** | Depth from rules + 1px inset highlight |
| 4-stop ink ramp | A 5th stop means the hierarchy is wrong |
| **Saturated colour ONLY for signal** | If a button borrows red, red stops meaning "broken" |
| IBM Plex Sans/Mono | Drawn for technical systems; reads as instrumentation |
| 13.5px base | Operators read at density, not marketing spacing |
| Small radii (3–8px) | Large radii read as consumer software |
| Status never colour-alone | ~1 in 12 men can't separate our red/green; it gets projected |

> **`frontend/src/app/globals.css` is the source of truth** and is heavily
> commented. Read it before writing any UI.

### Non-obvious UI choices — do not "fix" these

- **Muted is the LOUD state.** Every conference tool gets this backwards.
  On an incident bridge the costly failure is talking into a dead mic.
- **The graph canvas is read-only.** It's evidence of what was said. If you can
  drag on it, it stops being evidence.
- **No dismiss "X" on the contradiction alert.** Sweeping a conflict away
  without adjudication is the exact failure the feature exists to prevent, and
  it would be indistinguishable in an audit log from a real resolution.
- **Transcript auto-scroll only while pinned to the tail.** Yanking the
  viewport while someone reads backlog makes a live feed unusable.
- **`INFERRED` claims render dashed + badged "never spoken."** That visual
  quarantine is what a judge sees; the Bridge filter (S5) is what enforces it.

---

## 4. Architecture decisions

### Everything flows through one reducer

```
   S1 (Agora RTM)   ┐
   S3 (WebSocket)   ├──► IncidentAction ──► incidentReducer ──► UI
   Phase 1 (replay) ┘
```

The component tree cannot tell where its actions came from. Consequences:

- `src/lib/types.ts` is **the contract** — mirrors v6 §9.4 field-for-field
- `src/lib/mock-stream.ts` is **not throwaway** — it's Rehearsal Rig Tier 1
- RTM dedup lives in the reducer because it's domain logic, and must hold for
  replays and reconnect backfills too

**Integration point: `openBridge()` in `src/lib/incident-store.tsx`.**
It's commented with exactly what to replace. Nothing below it changes.

### Technical choices with non-obvious reasons

| Choice | Reason |
|---|---|
| `useVoiceEnvelope` writes `style.height` in rAF | The naive version calls `setState` 60×/sec forever |
| `useClock` uses `useSyncExternalStore` | Wall clock is an external system. One interval app-wide, no hydration mismatch |
| Graph nodes/edges are `useMemo` projections | React Flow's `useNodesState` drifts from the reducer |
| 8 handles per node, direction-aware edges | Default source-right/target-left loops arrows through their own source |
| `IncidentEntity` is a `type`, not `interface` | React Flow needs `Record<string, unknown>`; TS gives implicit index signatures to type aliases only |

### Trust zones (v6 §10.1) — enforced twice

| Layer | Mechanism |
|---|---|
| Build | `import "server-only"` in every Zone 2 module → build fails |
| Test | "Zone 1 cannot import Zone 2" scans the client tree → names the file in ms |

**Verified, not assumed:** I deliberately added `import { serverEnv }` to a
client component. The test failed in ~1ms and the build refused to compile
(`'server-only' cannot be imported from a Client Component module`). Then
reverted.

Zone 2 (Next.js) holds **Agora credentials only**. Jira/Slack/PagerDuty belong
in Zone 3 behind the Proxy Action Layer — a test fails if one appears here.

---

## 5. Corrections and honest caveats

*Recorded so nobody re-derives them or trusts something overstated.*

### ⚠️ The webhook signature check is a placeholder

`/api/agent-events` compares the `x-agora-signature` or `authorization` header
against `AGORA_WEBHOOK_SECRET` in constant time — a **shared-secret bearer
check**. Real webhook signing is usually **HMAC-SHA256 over the raw body**,
which is a different mechanism entirely.

I guessed the header name and format with no live delivery to check against.
The commit message called it "signature-verified", **which was overstated.**

> **Action for whoever gets the first real delivery:** inspect the actual
> headers. If it's HMAC, that function needs rewriting, not renaming.

### The Rule 2 tripwire has a negative lookahead — don't "simplify" it

`/\broot cause (is|was)(?!\s+not\b)/i`

Without the lookahead it fires on the **required** close-out line, "Root cause
is not established." It failed exactly that way when first written.

### In-memory Roster will break on serverless

`src/lib/server/roster.ts` is a `Map`. On Vercel, `/api/token` may write to one
instance and a later read hit another — the write-before-token invariant
silently becomes a lie.

Not a bug to fix now: v6 puts the canonical Roster in Python (Zone 3), and the
module is already behind an async interface with `ROSTER_SERVICE_URL` as the
swap point. **But do not deploy to serverless before S2/S3 land.**

### Blast-radius test was rewritten, deliberately

Phase 1 asserted "no secrets, no egress anywhere in `src/`". Correct while
`src/` was 100% client code; wrong once route handlers existed. It is now a
**boundary** check, not a blanket ban. Relaxing it globally would have gutted
it — that was considered and rejected.

### Screenshots caught what the build could not

Four real defects (§2, Session 1) passed typecheck, lint and build. The CDP
screenshot script lives in the scratchpad, not the repo. Recreate it if needed.

---

## 6. Environment & tooling notes

### Agora console decisions

| Question | Answer | Why |
|---|---|---|
| Which builder? | **Realtime Communications Builder** | Cosmetic workspace choice; both hit the same project. We drive Conversational AI via raw REST, not Voice Agent Builder's declarative UI |
| Webhook product? | **Conversational AI Engine** (not RTC) | Our handler only acts on agent lifecycle events. RTC events come from the SDK |
| Which events? | 101, 102, 104, 110 | expire (104) is the only one wired today; joined/left/errors drive agent state + degradation |
| Skip | 201/202/205 (telephony), 111 (chatty), 103, 112 | Not used, or S3+ |

**Webhook decision: deferred.** It only fires ~1h into a session, can't be
tested today, and any tunnel URL will have rotated by then. Configure it when
there's a permanent URL. It's S6 work.

### Credentials — where each comes from

| Variable | Location |
|---|---|
| `AGORA_APP_ID` | Console → Projects (32-char hex) |
| `AGORA_APP_CERTIFICATE` | same project → **Configure** → Primary Certificate (Enable if unused) |
| `NEXT_PUBLIC_AGORA_APP_ID` | same value as `AGORA_APP_ID` — public, safe |
| `AGORA_CUSTOMER_ID` / `_SECRET` | Console → **RESTful API** → Add a secret |
| `OPENAI_API_KEY` | platform.openai.com — needs `gpt-4o-realtime-preview` |

> ⚠️ **The most common setup failure:** `AGORA_CUSTOMER_ID/SECRET` is a
> **different credential** from `AGORA_APP_CERTIFICATE`. Tokens are signed with
> the certificate; the management API uses HTTP Basic with the customer pair.
> Crossing them gives an opaque 401 that looks like nothing is wrong.
>
> Agora shows the customer secret **once**. Copy it immediately.

Also: **Conversational AI Engine must be enabled on the project.** If not,
`/api/invite-agent` returns a 4xx that reads like a credentials problem. May
require Agora support depending on account tier — check early.

### Tunnelling (for webhooks)

Both `ngrok` (3.3.1) and `cloudflared` (2026.5.2) are installed. **Neither is
signed in.**

```bash
cloudflared tunnel --url http://localhost:3000    # no account needed
```

Prints a random `*.trycloudflare.com` URL. **Ephemeral** — dies with the
process, and restarts give a different name.

For a stable URL: ngrok free tier includes one static domain
(`ngrok config add-authtoken <token>`, claim domain, then
`ngrok http 3000 --domain=<yours>`).

Last session's tunnel: `https://attitude-air-cartridges-warned.trycloudflare.com`
— **almost certainly dead by now.**

### Tooling gotchas

- **Node 24 strips TypeScript natively** — tests use `node:test` with no test
  runner dependency. Test imports need explicit `.ts` extensions, hence
  `allowImportingTsExtensions` in tsconfig.
- **A dev server may already be running** outside the session. Next refuses a
  second one on the same directory — reuse it.
- **`.env*` in `.gitignore` swallowed `.env.local.example`.** Fixed with an
  explicit `!.env.local.example` negation. `.env.local` itself stays ignored.
- **Large heredocs through Bash fail** in this environment; use the Write tool.

---

## 7. What NOT to do

1. **Don't make Echo's dialogue more confident.** v5's script had Echo
   diagnose; v6 §6.3 lists those exact lines as violations. The tests fail the
   build if they return. **Restraint is the product.**
2. **Don't build the Bridge Controller before S0 passes.** That's the mistake
   v6 reordered the whole plan to prevent.
3. **Don't deploy to serverless before the Python Roster exists.** See §5.
4. **Don't relax the trust-zone tests** to make a build pass. Move the code
   instead.
5. **Don't trust a green build.** Screenshot the running app.
6. **Don't put Zone 3 keys in Next.js.** It changes a compromise from "can talk
   on one bridge" to "can page a human at 3am".

---

## 8. Reference map

| File | What it holds |
|---|---|
| `docs/echosphere_architecture_v6.md` | **THE governing architecture** |
| `docs/session_log.md` | This file — cross-session memory |
| `docs/handoff_log.md` | Structural handoff: layout, gotchas, how to run |
| `docs/task.md` | Slot checklist + Evaluation Ledger |
| `docs/echosphere_master_context.md` | v5 — superseded, kept as the record |
| `frontend/src/app/globals.css` | The design system, with reasoning |
| `frontend/src/lib/types.ts` | The Slow Loop data contract |
| `frontend/src/lib/incident-reducer.ts` | All state logic incl. RTM dedup |
| `frontend/scripts/s0-bridge-spike.mjs` | S0, ready to run |

```bash
cd frontend
npm run verify    # typecheck → lint → 72 tests → build
npm run test      # Rehearsal Rig Tier 1
npm run spike     # S0 — needs .env.local
npm run dev       # localhost:3000
```

---

> **Maintenance:** update this file at the end of any session that makes a
> decision, hits a dead end, or discovers something the code doesn't say.
> It is only useful if it stays honest — record the corrections too.
