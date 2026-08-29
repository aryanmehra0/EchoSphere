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
| **Last commit** | `db7faa3` docs: add cross-session context log |
| **Phase 1 (console UI)** | ✅ Done, v6-aligned — **run and screenshotted end to end, 0 console errors** |
| **S1 (identity layer)** | 🟡 Server code done and tested — never run against live Agora |
| **S0 (Bridge Spike)** | ⬜ Script **fixed** and dry-runs clean; not yet run live. Two bugs found Aug 27 — see §5 |
| **Tests** | 72 passing (`npm run verify` — full gate green Aug 27) |

### 🚧 THE ONE BLOCKER

**A TTS key is the last missing value** — `ELEVENLABS_API_KEY` by default, or
`SARVAM_API_KEY` with `TTS_VENDOR=sarvam`.

No OpenAI key was obtainable, so **the Fast Loop is now cascaded**: Agora ASR →
**Groq** (`openai/gpt-oss-120b`) → TTS vendor. Groq is in and verified; Agora
accepts it as a custom LLM. But Groq has no TTS and is not on Agora's vendor
list, and an agent without a `tts` block is rejected outright — so one TTS
credential is unavoidable if Echo is to speak. See "Groq instead of OpenAI"
below for the two risks that switch introduces.

Everything else is proven end to end: `/api/health` returns `ready:true` and
`/api/invite-agent` returns **HTTP 200 with a live agent** when a TTS key is
present (tested with an in-memory placeholder, agent stopped immediately).

Verify status any time (do not read the file, it holds secrets):

```bash
curl localhost:3000/api/health     # want {"ready":true,...}
```

As of this writing: four `true`, `OPENAI_API_KEY` `false`.

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

### Groq instead of OpenAI — what is and isn't possible (measured Aug 27)

No OpenAI key was available; a Groq key was. **Probed against the live Agora
API rather than reasoned about.** Results:

| Probe | Outcome |
|---|---|
| Groq as `llm`, no `tts` block | `HTTP 500 — "properties: tts.addon not found"` |
| Groq as `llm`, `tts` present (deliberately fake key) | **`HTTP 200, status RUNNING`** |

Two firm conclusions:

1. **A `tts` block is structurally mandatory.** An agent cannot run on `llm`
   alone.
2. **Agora accepts Groq as the LLM.** It never objected to the Groq endpoint —
   only to the missing TTS. Groq's API is OpenAI-chat-completions compatible
   with SSE, which is exactly what Agora's custom-LLM integration requires.

Note the create-time validation is **loose**: the fake TTS key was accepted and
the agent reached `RUNNING`. It would have failed only when it first tried to
speak. **A green `create` is not proof the voice path works** — that has to be
heard.

#### ⚠️ Agora does not validate `tts.params` AT ALL — a control proved it

Follow-up probe, checking whether the documented ElevenLabs / Sarvam parameter
names were right. All three attempts returned **HTTP 200, RUNNING**:

| Config | Result |
|---|---|
| `elevenlabs` with documented params (`key`, `model_id`, `voice_id`) | 200 |
| `sarvam` with documented params (`api_subscription_key`, `speaker`) | 200 |
| **CONTROL — `elevenlabs` with `{ totally_wrong_param_name: "x" }`** | **200** |

The control passing invalidates the other two rows. Agora checks only that a
`tts` block naming a **known vendor** exists — that is the `tts.addon not found`
error. Everything inside `params` is forwarded to the vendor adapter
**unvalidated**.

> **Operational consequence, and it is nasty:** a misconfigured TTS produces a
> healthy-looking agent that reaches `RUNNING`, joins the channel, and **never
> speaks**. There is no error anywhere in the create path. Agora publishes a
> support article on exactly this symptom ("No AI Voice playback").
>
> Therefore: **never conclude the voice path works from an API response.** The
> documented parameter names are the only source of truth, and the only real
> verification is a human hearing Echo — which is what S0 and
> `public/listen.html` exist to provide.
>
> **Corollary for debugging:** if Echo joins but is silent, suspect
> `tts.params` spelling FIRST. Sarvam wants `api_subscription_key`, not `key`,
> which is precisely the sort of thing that would cost an hour at 2am.

**What Groq cannot do:** there is no realtime speech-to-speech model on Groq
(`/models` lists `whisper-large-v3` and `whisper-large-v3-turbo` — STT only).
So the Fast Loop cannot stay audio-to-audio. It must become **cascaded**:
Agora ASR → Groq LLM → some supported TTS vendor. Agora's TTS list is
microsoft, elevenlabs, minimax, deepgram, cartesia, openai, humeai, rime,
fishaudio, google, amazon, sarvam — **Groq is not on it.** One TTS credential
is unavoidable if Echo is to speak.

**Where Groq is a straight win — the Slow Loop.** It covers three things S2–S4
would otherwise each need a credential for: `whisper-large-v3-turbo` for STT
(replacing AssemblyAI), and `openai/gpt-oss-120b` for both the extraction LLM
(§14.2) and the contradiction adjudicator (§7.1). The adjudicator is a narrow
four-label NLI task, which is where a fast open model is at its most reliable.

> **Two risks this creates, both real:**
>
> 1. **§12.1's latency budget no longer holds.** The ≤800 ms mouth-to-ear figure
>    explicitly assumed "no ASR→LLM→TTS cascade". Cascaded mode reintroduces
>    exactly that. Groq is the fastest inference available, so this may still
>    land near ~1.5 s — but it must be **measured in S0**, not assumed.
> 2. **Does Custom Instruction Injection still interrupt?** The entire Bridge
>    (§5) rests on `on_speaking_action: "interrupt"` cutting Echo off
>    mid-sentence. That behaviour was documented against the realtime path. In
>    cascaded mode the agent is mid-TTS-playback instead, which is a different
>    mechanism. **This is now the single highest-risk unknown in the project,
>    and S0 exists precisely to answer it.**
>
> A weaker model also raises the odds of violating §6 Rules 1–2, which are
> prompt-enforced. The Tier 1 tripwires and the S6 Tier 2 LLM-judge exist for
> this; do not relax them. Rule 3 is structural and unaffected.

### 🟡 Slow Loop pipeline built — works, but the headline feature is ~2-in-3 (Aug 28)

`extraction.py`, `redaction.py`, `contradiction.py` landed and are wired into
the ingest path. Speech now becomes graph nodes and ledger rows automatically,
and the epistemic split is real: Groq tagged *"Redis might be evicting keys"* as
**HYPOTHESIS** while four measurements went to **OBSERVED** with correct
attribution, and it volunteered an `unchecked` gap nobody stated.

**Four bugs found by testing, each of which silently broke something:**

| Bug | Symptom | Fix |
|---|---|---|
| `except … as first` unbinds at block exit (PEP 3110) | `UnboundLocalError` masked every schema failure | capture the message inside the block |
| dataclass field named `property` | shadowed the builtin decorator; module would not import | renamed `about_property` |
| retrieval threshold 0.12 | **the headline pair scored 0.111 and was discarded** | no threshold — Stage 0 already filters, TOP_K bounds cost |
| same speaker, same breath | DevOps "contradicted" himself twice before the real conflict | 15s same-utterance filter |

**Two more found only by running it live, both invisible to every test:**

1. **Unvalidated enums blanked the dashboard.** Extraction emitted an entity
   `kind` outside the six allowed values. The UI renders `GLYPH[kind]`, which
   returned `undefined`, and React unmounted the whole tree — a WHITE CONSOLE
   while the backend sat there perfectly healthy with a correct Ledger. Fixed
   in both layers: `models.coerce()` server-side, `?? fallback` client-side.
   **Before an LLM fed this wire the contract could be trusted. It cannot now.**
2. **Entity id drift silently disabled contradiction detection.** The model
   named checkout `e1` and Redis `e2` in window 1, then `checkout` and `cache`
   for the same two systems in window 3. Claims split across four ids for two
   real things, Stage 0 found no candidates, and the feature never fired —
   with every layer reporting success. Fixed with `resolve_entities()` plus an
   alias table carried across windows, and **established ids now outrank fresh
   proposals** at every step.

#### ⚠️ Where it actually stands: 2 of 3, not 3 of 3

Three consecutive rehearsals (the §17 S6 gate) gave: **contradiction shown in 2
of 3 runs, 0 console errors in all 3**, node counts stable at 2–3.

**The S6 gate is NOT met.** The variance is upstream of the adjudicator —
extraction splits the same four sentences into different claims and entities
each run, so the two conflicting observations sometimes land on one entity and
sometimes do not.

> **Recorded so nobody repeats it:** setting extraction `temperature` to 0.0
> looks obviously right for a transcription task and tested **worse** — 0 of 3
> versus 2 of 3. Groq does not guarantee determinism at 0 anyway, so it buys no
> reproducibility and just locks in whichever split the model lands on. n=3
> each, so this is weak evidence, not a settled answer. Reverted to 0.2.
>
> **And a correction:** the run that reported "3 of 3 clean" was my own
> measurement being wrong — PowerShell's `-match` is case-insensitive, so the
> pattern `.*SHOWN` matched "not shown". The true figure was 0 of 3. A harness
> that cannot fail is worth nothing; this is the second time this session a
> detector produced a false pass (the first was the all-zero interrupt trace).

**Next iteration, in order:** Rehearsal Rig Tier 2 to *measure* detection rate
over fixed fixtures across N runs rather than eyeballing three; then either
pin claim/entity ids deterministically in the extraction prompt, or make
scoping tolerant of a claim spanning two entities.

### ✅ The dashboard is LIVE — G6 closed end to end (Aug 28)

`openBridge()` no longer starts the scripted replay. It opens the Slow Loop
delta socket and **falls back to the replay only if Python is unreachable**,
which keeps §17's "the dashboard is the fallback demo" true without a second
code path — both sources dispatch identical `IncidentAction`s into the same
reducer.

Verified with a headless browser against the running backend:

| Check | Result |
|---|---|
| Status bar reports the real source | ✅ **LIVE DATA**, not REHEARSAL |
| Claims pushed from Python render on the dashboard | ✅ 2 on screen |
| **Reload mid-incident** | ✅ **2 claims restored from SNAPSHOT — G6 closed** |

**New pieces:** `src/lib/delta-socket.ts` (HELLO / SNAPSHOT / REPLAY, backoff,
and gap detection *while connected* — a `seq` jump forces a resync, because
silent divergence is the failure hardest to spot on stage), and a `SNAPSHOT`
reducer action.

> **Why SNAPSHOT is not just another DELTA.** A snapshot must **replace** the
> server-owned collections; merging would preserve rows the server has since
> dropped, and a reconnecting dashboard showing claims that no longer exist is
> worse than one showing nothing. It preserves what the CLIENT owns — transport
> state, the incident clock, the transcript scrollback — because the server has
> no opinion about whether this browser is connected.

**Two honesty fixes made while wiring it, both from looking at the screen:**

1. **The status bar was lying.** It read `gpt-4o-realtime` and
   `assemblyai/universal-3.5` — neither has been in the request path since the
   move to a cascade. That strip is where an operator confirms *which system
   they are talking to*, so a stale vendor name there is worse than none. Now
   `groq/gpt-oss-120b`, `agora` ASR, `elevenlabs/flash-v2.5`.
2. **A replay must never pass as live.** The status bar now shows **LIVE DATA**
   (green) or **REHEARSAL** (amber). A scripted replay that reads as a real
   incident is a lie the operator cannot detect — and a product about not
   letting assumptions pass as facts does not get to exempt its own console.

**Also added:** `POST /incident/reset`. The Ledger is a live in-process object,
so a second run inherited the first one's claims and its `phase: resolved` — a
dashboard opening on an incident nobody has had yet. S6 needs three clean runs
back to back; this makes that possible without restarting the process.

**The egress test was narrowed, not relaxed.** Its original comment promised
that when the delta socket landed it would "live behind a named module and this
test will be narrowed to permit exactly that one." That is now literally true:
one allow-listed file, plus a second test asserting that file exists and reaches
only the Slow Loop — so the allow-list can never quietly protect nothing.

### ✅ THE BRIDGE WORKS — but via `/speak`, not instruction injection (Aug 28)

**S0's blocker is resolved, and the fix is an architectural upgrade.**

Instruction injection (`POST /agents/{id}/update` with `on_listening_action:
"inject"`) reliably returned HTTP 200 and reliably produced **no speech**. It
asks the LLM to *decide* to say something; with a long "default is ABSOLUTE
SILENCE" prompt, a well-behaved model decides not to.

Agora has a dedicated endpoint that drives the TTS module directly:

```
POST /api/conversational-ai-agent/v2/projects/{appId}/agents/{agentId}/speak
     { "text": "..." }                                    -> 200, Echo SPEAKS

POST /api/conversational-ai-agent/v2/projects/{appId}/agents/{agentId}/interrupt
     {}                                                   -> 200 in 433 ms
```

Measured on a live channel: `/speak` produced **80% peak audio** from uid 9000.
`/interrupt` took the level from 58% to zero within ~1.4 s and it stayed there.

> **Why this is better than what v6 specified, not merely different.**
>
> With injection, Echo's words are the model's paraphrase of an instruction, so
> §6 Rules 1–2 (attribution mandatory, causation interrogative) depend on the
> model's discretion — exactly the weakness §6.2 admits: "Rules 1 and 2 are
> prompt-enforced and could be violated by a creative model."
>
> With `/speak`, **the Slow Loop sends the literal sentence**. Attribution and
> non-causal phrasing are composed in Python, where they can be unit-tested and
> regex-tripwired before a single byte reaches the channel. The brief's hardest
> constraint moves from "we asked the model nicely" to "the model cannot phrase
> it at all." Rule 3 was already structural; now Rules 1 and 2 are too.
>
> **Consequence for S5:** the Bridge Controller composes exact utterances and
> calls `/speak`. The Fast Loop LLM is then only needed for *conversational*
> replies (direct questions), not for Echo's proactive interventions.

**Detector caveat, recorded so nobody trusts it blindly:** the first automated
"did it interrupt" check reported success against an all-zero trace, because
"some samples are zero" is trivially true of silence. Any interrupt assertion
must first establish that audio WAS present.

### 🛑 Sarvam-via-Agora is BROKEN upstream (Aug 27–28) — not our bug

**Echo spoke, then stopped speaking, and our code never changed.** The full
evidence trail, because this cost hours and will otherwise be re-derived:

| Time | Config | Result |
|---|---|---|
| ~19:1x | sarvam, no `model`, speaker `anushka` | ✅ **audio, peak 83%** |
| ~19:1x | sarvam, `model: bulbul:v2`, `anushka` | ✅ audio, peak 78% |
| ~19:1x | sarvam, `key` instead of `api_subscription_key` | ❌ silent (expected) |
| ~00:0x | **the identical first config** | ❌ **silent** |
| ~00:0x | `model: bulbul:v3` + `anand` | ❌ silent |
| ~00:0x | no model + `anand` | ❌ silent |

What changed in between was **not ours**: Sarvam deprecated `bulbul:v2`. Calling
Sarvam **directly** proves the account and key are perfectly healthy:

```
bulbul:v2 → HTTP 400  "Model 'bulbul:v2' has been deprecated. Please use 'bulbul:v3'"
bulbul:v3 + anushka → HTTP 400  "Speaker 'anushka' is not compatible with bulbul:v3"
bulbul:v3 + anand   → HTTP 200  71544 bytes of wav in 905 ms
```

So: **v3 works when called directly, and fails through Agora even when pinned
explicitly.** The strong inference is that Agora's Sarvam adapter is still bound
to the deprecated `bulbul:v2` and ignores or overrides the `model` we pass.
Nothing we can configure reaches a working model.

> **Do not burn more time on Sarvam params.** The config in `agent-config.ts` is
> correct — it was verified working before the deprecation, and it is pinned to
> `bulbul:v3` with a compatible speaker. It will start working the moment Agora
> updates their adapter. The blocker is upstream.
>
> **Use a different TTS vendor.** Agora's list: microsoft, elevenlabs, minimax,
> deepgram, cartesia, openai, humeai, rime, fishaudio, google, amazon, sarvam.

**What this episode proves about the architecture, and it is worth keeping:**
every layer reported success while the product was broken. Agora said
`RUNNING`, `message: "ok"`. `/api/health` said `ready:true`. `/api/invite-agent`
returned 200 with an agent id. The gate was green at 80/80. **Only measuring
uid 9000's actual audio level revealed the truth.** That is the whole reason the
session log says "don't trust a green build" — and it now has a second, sharper
case behind it: don't trust a green *dependency* either.

**Reusable asset:** the volume-probe harness (headless Chrome on the channel,
sampling the per-UID volume indicator) is the only instrument that can tell
whether Echo really spoke. It lives in the scratchpad, not the repo. Rebuild it
before S0 rather than trusting an API response.

### Session 6 — first real run of the app (Aug 27)

**Ask:** "run the project, execute it, then move to the next phase."

`npm run verify` green: typecheck → lint → **72/72 tests** → production build.

**Drove the running app end to end** via a headless-Chrome CDP driver (not in
the repo; scratchpad only) — clicked *Join incident bridge*, let the full ~50s
Demo Script v2 replay run, screenshotted all four Acts and all four
intelligence tabs. Result: **12 transcript rows, 5 entities, 4 edges, 8 claims,
0 console errors.** The contradiction alert fired, was adjudicated, and cleared.
Close-out reached `resolved` with `vpc-us-east-1a` still amber, as §18 intends.

**Two bugs found in `scripts/s0-bridge-spike.mjs` — it could never have run.**
See §5. Both fixed. This matters more than it sounds: S0 is the next thing to
execute and it needs a live channel and a human ear, so both would have burned a
real rehearsal.

**Environment fact, measured not assumed:** `.env.local` **exists** and is 5,032
bytes (the template is 2,743) — but every one of the five values is blank.
`/api/health` on a *freshly booted* server returns `ready:false` with all five
`false`. The file's size is comments, not credentials. `task.md` and
`handoff_log.md` both said "does not exist", which sends you looking for the
wrong problem; corrected in both.

**Note:** a `next dev` server (PID 29612) was already running on :3000 from
outside the session — the §6 gotcha, confirmed real. A second `npm run dev`
correctly refuses to start.

**Agora credentials landed and were PREFLIGHTED (Aug 27).** Four of the five
values are in. A read-only preflight verified all four independently, so the
first live S0 run is not also a credentials experiment:

| Check | Result |
|---|---|
| Token mints offline (app id + certificate are a valid pair) | ✅ 171 chars, `007` prefix |
| Customer ID/secret authenticate — `GET /dev/v1/projects` | ✅ HTTP 200 |
| **App id belongs to that customer account** | ✅ — rules out the §6 conflation failure |
| Conversational AI Engine enabled — `/conversational-ai-agent/v2/.../agents` | ✅ HTTP 200 |

That fourth row is the one worth having early: §6 warns it can require Agora
support depending on account tier. It does not.

**Still missing: `OPENAI_API_KEY`.** `/api/health` returns `ready:false` with
that as the only entry in `missing[]`. S0 cannot run without it — the spike
passes it to Agora as the Realtime vendor key. Needs `gpt-4o-realtime-preview`
access on the account.

**Housekeeping:** `.env.local` is confirmed ignored (`.gitignore:34` `.env*`)
while `.env.local.example` stays tracked via the `!` negation, so the real
values cannot be committed. The customer secret was pasted into a chat
transcript to get here and Agora only displays it once — **rotate it after the
hackathon.**

#### The gap that blocked S0 — no way to hear Echo

The spike's usage notes say *"Open the dashboard and join the channel so a human
can HEAR the agent."* **That was not possible.** `agora-rtc-sdk-ng` and
`agora-rtm-sdk` are installed but **never imported anywhere in `src/`** — the
console's *Join incident bridge* runs the scripted replay and nothing else. So
S0 steps 2–4, all three of which are human-ear judgements, had no ear.

Fixed with **`frontend/public/listen.html`** — a deliberately throwaway page:
plain HTML, no React, SDK vendored at `public/vendor/` (no CDN, no version
drift), nothing under `src/` imports it so the trust-zone tests are untouched.
It mints a token, joins, publishes a mic, plays remote audio, and draws a
per-participant volume bar — the bar is what lets you *see* whether
`on_speaking_action: "interrupt"` truly cut Echo off or merely queued.

> **Delete `public/listen.html` and `public/vendor/` when S1 replaces the replay
> in `openBridge()` with a real RTC join.**

One small app change was needed: `/api/token` now also returns `appId`. That
value is not a secret — it ships inside every Agora client bundle, and
`.env.local.example` says so explicitly — and returning it means one call gives
a joiner everything it needs, which S1's client wiring will want too.

#### ✅ S1 partially proven LIVE (first time ever)

Driving that page headlessly against real Agora:

| Step | Result |
|---|---|
| `POST /api/token` with a real certificate | ✅ uid 1002, `authorized:true`, RTC 175ch + RTM 143ch, both `007` |
| Roster write-before-token ordering | ✅ sequential allocation held — 1001 was consumed by an earlier probe, so this call got 1002 |
| Real SD-RTN join | ✅ `DISCONNECTED → CONNECTING → CONNECTED` on `inc-spike` |
| Microphone publish | ✅ |
| Clean leave | ✅ |

**The S1 gate is still not met** — it requires *two humans + Echo* on the
channel with every UID resolving to a role. One browser joined, and Echo cannot
join until `OPENAI_API_KEY` exists. But the token → roster → SD-RTN path is no
longer theoretical.

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

### ⚠️ The S0 spike script was never runnable — two bugs, both now fixed

`task.md` said "Spike script written, syntax-checked, fails cleanly without
creds." Syntax-checked it was. Runnable it was not. **Neither bug is about
credentials — both would have fired on a fully configured machine.**

**1. `join` was shadowed.** `const join = await agora(.../join)` shadowed the
`join` imported from `node:path` for the whole of `main()`. The report write at
the end — `writeFileSync(join(ROOT, "s0-spike-report.json"), …)` — therefore
threw `TypeError: join is not a function`, *after* all four operator prompts had
been answered and *before* the verdict printed. A whole live rehearsal, with a
human on the bridge, for a stack trace. The variable is now `launch`.

**2. `agora-token` needs `.default` under plain Node.** The package is CommonJS,
and Node's `cjs-module-lexer` detects only `ApaasTokenBuilder` as a named export
— `RtcTokenBuilder` and `RtcRole` are reachable *only* through the default
object. So `const { RtcTokenBuilder } = await import("agora-token")` yielded
`undefined` and died at the first `.buildTokenWithUid`, before any credential
check could report itself.

> **Why the app doesn't hit this:** `agora-tokens.ts` uses a static
> `import { RtcTokenBuilder } from "agora-token"` and the bundler performs the
> interop. The `.mjs` script runs under plain Node, which does not. **Any future
> standalone script importing a CJS dependency needs the same `.default`.**

Verified after the fix: the script now stops with
`✖ Missing AGORA_APP_ID in .env.local` — the clean failure the docs always
claimed.

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
