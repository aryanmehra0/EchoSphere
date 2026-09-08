# 🧠 Session Context Log — EchoSphere

> **Purpose.** This file is the memory that survives between chat sessions.
> Code and git history record *what* exists. This records *why* — the decisions,
> the dead ends, the corrections, and the things a fresh agent would otherwise
> re-derive or re-break.
>
> **If you are an agent or developer starting a new session: read this file
> first, then `echosphere_architecture_v6.md`, then `handoff_log.md`.**
>
> **Last updated:** September 8, 2026

---

## 1. Where we are right now

| | |
|---|---|
| **Governing architecture** | `docs/echosphere_architecture_v6.md` (v6 supersedes v5) |
| **Branch** | `main` — **uncommitted work** (Panel + consent gate, Aug 31) |
| **Phase 1 (console UI)** | ✅ Done, v6-aligned — run and screenshotted end to end |
| **S1 (identity)** | 🟡 Code done and tested — never run against live Agora, two machines |
| **S2 (Observer)** | 🟡 Adapter seam only. Agent-UID exclusion (G2) live; real PCM blocked on Python 3.14 |
| **S3 (Ledger/extraction/deltas)** | ✅ Verified live — speech to graph in under 4 s, screenshotted |
| **S4 (contradiction)** | ✅ Panel Aug 31; scoping fixed Sep 6. **RTI removed Sep 8** — no producer, see Session 8 |
| **S5 (Bridge + Authorization Gate)** | ✅ Verified live: verbal yes denied, wrong role rejected, replay rejected |
| **S6 (Rig + degradation)** | 🟡 Tiers 1-3 exist; **Tier 3 is new (Aug 31)**. Dress rehearsals below |
| **7a Deliberation Panel** | ✅ New Aug 31 — replaced the single adjudicator |
| **10.5 Consent gate** | ✅ New Aug 31 — off the record, verified leaves no trace |
| **Tests** | **125 frontend** (`npm run verify` green) + **199 backend** = 324 |
| **Voice path** | ✅ Verified live Aug 31 — `spoken: true`, 790 ms. Was never wired before. |
| **Demo runbook** | `docs/DEMO.md` — three modes, the script, the questions judges ask |

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

### Aug 31 (2) — Echo had never actually spoken, and nothing said so

Checking whether the product's central claim was true turned up the largest
defect in the project. `/health` reported `agent: {agent_id: null}` after every
rehearsal, because:

- **Nothing called `/api/invite-agent`.** The route existed, was tested, and
  was invoked by no one. The console minted tokens and joined RTC, and stopped
  there. Echo was never put in the channel at all.
- **Nothing called `/agent/register`.** So even with an agent, the Bridge
  Controller had no id to speak through and `_bridge()` returned `None`.

Every other link worked. Tokens minted, RTC joined, claims extracted,
contradictions detected, dashboard filled. **Nothing errored — it was simply
silent**, which is why five days of rehearsals never caught it. An AI incident
commander that cannot talk is a dashboard.

Fixed as a chain: join → invite → register → speak → leave → stop. Verified
live: `{"spoken": true, "status": 200, "latencyMs": 790}`.

#### Three things that came out of the fix

**The invite is idempotent per channel** (`lib/server/active-agents.ts`). §18
puts two humans on two machines and both consoles join the same channel —
without this, both invite, and the room gets two Echoes answering every
question in slightly different words. That looks exactly like the product being
broken.

**Leaving RTC does NOT stop the Cloud Agent.** It is a separate server-side
process that Agora keeps running, and billing, until its own timeout. There was
no way to stop one from inside the app, so every rehearsal left another Echo in
the channel. `/api/stop-agent` now exists and `closeBridge` calls it, as does
the unmount path. **Ten rehearsals without this leaves ten Echoes and the tenth
demo looks broken.**

**The invite must never block the dashboard.** §17's standing rule. It is fired
alongside the join, not awaited before it, and a failure degrades to a banner —
`ECHO CANNOT SPEAK` when the agent joined but the Slow Loop never got the id,
which is otherwise impossible to diagnose from inside the room.

#### ⚠️ The panel was rate-limiting itself into silence

First live Mode A rehearsal after wiring the panel in: the log was full of
`429 Too Many Requests` and the headline contradiction never fired. The
analysis was correct and never got to run.

Two causes, and the first is genuinely counter-intuitive:

**Groq's per-minute limit counts RESERVED output, not produced output.** Its
own 429 says `Limit 8000, Used 6140, Requested 1903`. At the default
`max_tokens=4096`, three personas reserve 12k against an 8k/minute ceiling
before a single token comes back.

The obvious fix — "a verdict is 40 tokens of JSON, reserve 320" — is **wrong**,
and failed immediately with `max completion tokens reached before generating a
valid document`. `gpt-oss-120b` is a REASONING model: it emits reasoning tokens
before the JSON, so a tight ceiling truncates it mid-thought and every persona
abstains. That converts a rate-limit problem into a total-silence problem.

`PANEL_MAX_TOKENS = 1536` is the measured middle. **Do not tighten it to "just
enough for the JSON".**

**Second: `retrieve` returns TOP_K=5 and every pair convened a full panel** —
up to 15 calls for one new claim. `PANEL_PAIR_BUDGET = 2` now caps it; beyond
that the engine falls back to the single judge, which is a sound floor since it
was the entire system the day before. The headline conflict has always been in
the top two by similarity.

Result: 429s went from a flood to **zero**, and the S6 gate passes again.

#### The §6 tripwire 500'd the ingest endpoint

`utterance.validate()` refused `"Recording resumed."` — no attributed source,
Rule 1. Correct in itself, but the exception escaped the privacy branch and the
endpoint carrying *every utterance* returned a non-JSON 500.

Both halves fixed. The announcements joined `_NO_CLAIM`, which is the right
home — they assert nothing about the incident, they report Echo's own state,
and §10.5 rule 3 *requires* Echo to say them aloud. And the speak call is now
wrapped: **a guard that can crash the ingestion path is the wrong shape
regardless of which phrases currently pass it.** Losing an announcement costs a
spoken confirmation; losing the endpoint costs the incident record.

`_NO_CLAIM` is still anchored prefixes naming specific things Echo does, never
a general escape — there is a test asserting an unattributed *finding* is still
refused.

#### docs/DEMO.md

Written because "how do we show this" had no answer. Three modes ordered by
risk, the script with what to say over it, the questions judges ask, and a
pre-flight checklist.

The headline: **two machines, not three, and never two tabs on one laptop.**
One laptop has one microphone, so both tabs hear the same voice and both
forward it under different roles — Echo then compares a person to themselves
and misattributes their words. That is the exact failure per-UID separation
exists to prevent. Headsets, not speakers, for the same reason by a slower
route.

---

### Aug 31 — mentorship review: the adjudicator was one biased judge, and Echo could not be turned off

Two things came out of the mentorship round, and both landed on real gaps
rather than cosmetics. Recording them because the *reasoning* is the part that
will not survive in the diff.

#### The single judge had a bias baked into its prompt

`ADJUDICATION_PROMPT` contains, in capitals, `THE MOST COMMON MISTAKE IS
OVER-USING "OPPOSED"`. That was added for a good reason — early runs
interrupted the room over two symptoms of one fault. But it over-corrected,
and a live rehearsal caught it. The headline pair:

    DevOps Lead       "Memory is at 40 percent. The cache is fine."
    Support Engineer  "application logs are showing cache read timeouts"

came back **INDEPENDENT** and the room heard nothing. Entity resolution was
right (both on `redis`), scope was right (different speakers, 14.3 s apart),
retrieval was right. The prompt's own example table teaches INDEPENDENT for
the memory/timeout pair and OPPOSED for the fine/timeout pair — so the verdict
depended on which candidate came back first.

**One prompt cannot sit at both ends of a precision/recall tradeoff.** So
Stage 3 is now `app/panel.py`: a SKEPTIC biased against firing and a SEEKER
biased toward it, on two different models, with a REFEREE settling splits.

Three things worth keeping:

- **Different models per persona is not decoration.** It buys independence
  (they cannot anchor on each other) and, because Groq's daily cap is scoped
  PER MODEL, it draws each persona from a separate bucket. A three-persona
  panel costs roughly what one adjudication cost, in quota terms.
- **The personas argue about EVIDENCE, never about cause.** The mentor's
  phrasing — "compare answers and say why one is wrong" — would break Rule 1
  taken literally. The Referee says why a *reading* is wrong, never why a
  *system* failed. That is what keeps the panel inside the rubric.
- **A prompt asking a model not to diagnose is a request, not a guarantee.**
  The personas tried to diagnose six times across the live runs. The first
  tripwire was a phrase list and it missed every one — including "High latency
  is a direct technical cause of user-facing failures" and "causally linked
  symptoms of the same underlying incident". It is now structural: a causal
  connector in the same SENTENCE as telemetry vocabulary. Reasoning about a
  reading carries no telemetry noun and survives; reasoning about the system
  always names one, and dies. Both live escapes are pinned as tests.

#### ⚠️ The panel introduced its own false positive — and cost a demo beat

First live run after wiring it up, this fired at 90%:

    "Users say their carts empty"  vs  "Latency is through the roof"

Both analysts were right — those ARE different properties. That is exactly the
problem: **unanimous agreement that two claims are independent is the DEFAULT
for any two claims about one entity**, and averaging two confident votes clears
a fixed gate far more easily than one vote ever did.

INDEPENDENT now also requires the analysts to have **disagreed**. A split is
the signal that something subtle is happening; easy unanimity is the signal
that nothing is.

**This deliberately silences a scripted Demo Script v2 beat** — the redis
memory/timeout pair no longer interrupts. Judged worth it: one sharp
intervention beats two soft ones, and a false interruption costs more trust
than a missed nuance. *If a future session wants that beat back, the lever is
`PanelVerdict.is_actionable`, and the tradeoff is written there.*

Related arithmetic bug, caught by its own test: the gate is checked AFTER the
dissent penalty, so leaving `INDEPENDENT_GATE` at 0.85 while subtracting 0.15
meant only a perfect 1.00 could ever pass. The path was dead. Rebased to 0.70,
which is the same effective bar the single judge held at 0.85.

#### Echo could not be turned off

The mentor's other question: what happens when two people say something to
each other that was never meant for the record?

The honest answer was that §10.4 redacts PII before the LLM and before
embedding, and the Ledger stores structured claims rather than the
conversation. Both true, **and both beside the point** — redaction decides
what a *vendor* sees; it gives the people on the bridge no say in whether they
are minuted at all. There was no way to turn Echo off.

`app/privacy.py` is the answer. Three rules, all load-bearing:

1. **Speech is the control.** Nobody alt-tabs mid-Sev-1. Fixed phrases, not
   intent classification: an LLM here is slower than speech, fails OPEN
   (recording) when rate-limited, and a false negative is unrecoverable
   because the words are already in the Ledger by the time anyone notices.
2. **Suspended means nothing is kept** — not the text, not a redacted copy,
   not a log line containing it. Only a count, which is what makes the pause
   auditable without making it a leak.
3. **The room must see it.** A recording state nobody can perceive is worse
   than no control at all, because people believe whichever state they
   assumed. The banner is not dismissible, for the same reason the
   contradiction alert has no X.

Verified end to end, not merely unit-tested: a distinctive sentence spoken
while suspended is absent from `/tools/query_incident_state`,
`/privacy/inventory` and `/audit` afterwards. That check is now in Tier 3.

`/privacy/inventory` exists because "we redact PII" is an assurance, and an
assurance is not evidence. It reports real counts, where they live, and that
nothing survives a restart.

#### Rig Tier 3

Tiers 1 and 2 never touch HTTP, the Ledger singleton, the Delta Hub or the
consent gate — both stayed green through a live run where the dashboard showed
nothing. Tier 3 drives the running server at conversational pace and asserts
against the API.

**Why against the API and not the DOM:** my own screenshot harness lied twice
in one day — once passing an interrupt check against an all-zero trace, once
reporting "contradiction surfaced ✓" because the regex matched the word
`CONFLICTS` in the header chrome, and twice reporting HYPOTHESIS/OBSERVED
missing when the UI simply renders them as ESTABLISHED and OPEN QUESTIONS. Do
not trust a harness that string-matches rendered text.

```bash
.venv/Scripts/python -m rig.tier3 --runs 3   # the S6 gate
```

Three CONSECUTIVE clean runs, not an average — the failure it catches is state
leaking between runs, and an average hides exactly that.

---

### Aug 30 (2) — reviewed another session's RTM work; two bugs that only appear on two machines

A parallel session moved RTM transcript forwarding into the console —
`agora-bridge.ts`, `agora-transcript.ts` and a test file. Good work: the parser
is typed, pure and unit-tested, forwarding is routed through `delta-socket.ts`
so the single-egress boundary holds, and `AgentPresence` finally receives the
REAL Echo track instead of a synthesised envelope.

Review found three problems. All three were invisible on one laptop.

**1. Every transcript was attributed to whoever's browser received it.**
`credentials.role` is the LOCAL user's role, but RTM broadcasts to every
subscriber — so on the two-machine setup §18 makes a hard requirement, DevOps's
console received Support's utterance and forwarded it labelled "DevOps Lead".

A MIS-sourced claim is worse than an unsourced one: §6.2 Rule 1 catches the
second and nothing downstream can catch the first. The contradiction engine
would then compare two people's claims believing them to be one person's.

Fixed with `forwardDecision()` — each participant forwards ONLY their own
speech, because a browser knows exactly one role for certain. Pure and exported
so it can be tested without two machines on a channel, which is precisely the
configuration it exists for and the one that cannot be exercised on a laptop.
Six tests pin it.

**2. The same utterance was forwarded by every browser.** Same root cause, and
it doubled extraction. Fixed client-side by (1), plus a backstop:
`TurnWindow.add()` now dedupes by `message_id` and returns whether the frame was
taken. RTM does not guarantee once-only delivery and a reconnecting browser can
replay, so this is worth having regardless of what the client does.

> Dedup is by message id, NOT by text. Two engineers independently reporting
> "the cache is fine" is a real signal, and collapsing them would erase one
> person's contribution to the record. The test helper had been deriving ids
> from text alone, which made that case look broken — the helper was wrong.

**3. The dashboard was made to depend on the microphone.** `openBridge` joined
Agora BEFORE opening the delta socket and returned early on failure, so a denied
mic permission or a stale token took the LIVE DASHBOARD down with it — while the
Slow Loop was healthy and everyone else's speech was still being analysed.

§17's standing rule is explicit: *never let a change make the dashboard depend on
the Fast Loop*. Order inverted — socket first, microphone second. A failed join
now costs only this operator's voice and raises the ANALYTICS-ONLY rung of §13's
ladder with a banner saying so.

**Verified after:** 222 tests (127 backend + 95 frontend), live run LIVE DATA
with 0 console errors, contradiction fired in the backend.

> **Harness note:** `final-demo.mjs` now checks the DOM too early. Extraction
> takes 20–60 s per window on the primary model, and the script allows 6.5 s
> between lines — so a run can report "contradiction not shown" while the
> backend has one. Widen the waits before trusting that line again.

### Aug 29 — S4/S5/S6 built, and the Rig turned tuning into measurement

**Everything remaining was built:** Rehearsal Rig Tier 2 (§15, closes G8),
`rti.py` (§8, closes G5), `authorization.py` + `proxy.py` (§10.2, §4.5, closes
G7), and the dashboard's approval modal. **111 backend + 85 frontend tests.**

#### Tier 2 paid for itself immediately

Contradiction detection had been ~2-in-3 and every attempt to fix it was
guesswork. The Rig localised the fault in ONE run: entity convergence was 20%,
with the same note every time — `'40 percent' -> None`. Extraction splits one
spoken sentence into several claims and only the FIRST carries the subject, so
text matching could never resolve the rest.

Four fixes, each measured rather than assumed:

| Fix | Detection | Entity convergence |
|---|---|---|
| baseline | 20% | 20% |
| claims inherit the window's entity | 60% | 75% |
| prompt: entity ids are stable, reuse them | 83% | **100%** |
| adjudication gate 0.75 → 0.60 | **100%** | 100% |

Precision stayed at **100%** on both negative scenarios throughout, which is
the only reason lowering the gate was defensible.

#### Then the 4-line scenario found what the 2-line one could not

- **A false positive.** It fired on "tickets are flooding in" vs "500s spike" —
  two symptoms that AGREE. Fixed two ways: INDEPENDENT now needs 0.85 while
  OPPOSED needs 0.60 (OPPOSED is unambiguous; INDEPENDENT is also the correct
  label for two unrelated observations), and the adjudication prompt now
  carries worked examples of symptom pairs that are NOT opposed.
- **Multi-entity claims.** "cache read timeouts on the checkout path" names two
  systems. Longest-alias-first picked `checkout` and split it from the Redis
  claims. Now EARLIEST mention wins — a claim is about the first thing it
  names; the rest is context.
- **Synonyms.** "the cache" IS the Redis entity, and nothing said so. The
  extraction prompt now asks for `aliases` per entity and they are threaded
  through resolution, so a later sentence saying only "the cache" resolves
  correctly.

#### ⚠️ Groq's limits are TOKENS PER DAY, and they are per model

A day of measurement exhausted `openai/gpt-oss-120b` outright — 200,000 TPD,
used 197,903. Every call then 429'd with "try again in 21m", which against a
DAILY budget is not a wait, it is a wall. Retrying cannot clear it.

Because the quota is scoped per model, `analysis_models()` is now a chain
(`gpt-oss-120b` → `gpt-oss-20b` → `qwen3.8-27b`) and a daily-cap 429 falls
through immediately instead of sleeping. Verified: the pipeline kept running on
the fallback with all six quality metrics at 100%.

> **Known limitation, stated plainly.** The fallback models are smaller and
> visibly worse at the adjudication: on `gpt-oss-20b` the symptom-pair false
> positive returns in ~2 of 3 runs. So the S6 gate is met on the PRIMARY model
> and not on the fallbacks. Before the finale, either upgrade the Groq tier or
> budget the daily tokens — a full demo run costs roughly 15–20k, so 200k/day
> is about ten rehearsals, and today's tuning consumed all of it.

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

### Sep 3, 2026 — Echo could speak, but you could not talk to it

The report was "it is not working, and I want the conversational AI agent to
work properly with proper talking." Both halves turned out to be true, and
neither was the thing that had been assumed.

**Two false alarms first, because they are the more useful lesson.**

`curl http://localhost:3000/api/health` returned `308` redirecting to itself —
every route, `/` included, which in a browser is `ERR_TOO_MANY_REDIRECTS`. A
long theory followed about `next build` having clobbered the dev server's
`.next` while it ran. It had not. The agent's Bash tool runs behind a sandbox
proxy (`HTTP_PROXY=127.0.0.1:58080`) that intercepts localhost. From the host,
`Invoke-WebRequest` returned `200` with every credential present, and always
had. **The console was never broken.**

Then the join greeting came back from Agora's `/history` reading
`session â it is on the dashboard` — the classic UTF-8-as-Latin-1 mojibake.
A fix was written to send ASCII-escaped JSON, complete with a long comment
explaining a corruption that does not exist. Re-reading the response bytes and
decoding them explicitly showed a single clean `U+2014`. **PowerShell 5.1's
`Invoke-RestMethod` decodes as ISO-8859-1 when the response has no `charset`
in its `Content-Type`.** The fix was reverted, because a change resting on a
false premise leaves a comment that will mislead the next person.

That is now **four** times in this project a harness has reported a defect
that was in the harness. §7 of `CLAUDE.md` says do not trust your own harness.
Extend it: **when a probe reports something surprising, verify the probe before
believing the finding.** Both of these cost more than the real bug did.

**The real defect.** Echo speaks fine — `/bridge/say` returns 200 in ~720 ms
and Agora's own `/history` records the assistant turn with
`start_type: "api_speak"`. What did not work was *conversation*, for two
reasons that compound:

1. **Echo joined in total silence.** `greeting_message` was `""`, so from
   inside the room a working agent, a failed invite, a wrong channel and a
   mute TTS vendor all look identical. All four have happened here.

2. **Tools were disabled, and the prompt did not know.** Agora's Engine calls
   REST tools from *its own servers*, so with no public URL the agent is
   created with no tools at all — `toolsEnabled: false`. Echo was then under
   Rule 3 ("NEVER ANSWER FROM MEMORY, call `query_incident_state`") while
   holding no such instrument. A model in that bind either goes silent, which
   reads as broken, or decides the rule cannot have meant this and answers
   from memory — which is precisely the confident unsourced answer this
   product exists to prevent.

**What was built.**

| Change | Where |
|---|---|
| `joined()` — the join announcement, §6-validated like every other line | `backend/app/utterance.py` |
| Spoken on registration, best-effort so a hoarse vendor cannot fail the invite | `backend/app/main.py` |
| `NO_TOOLS_ADDENDUM` — names the situation instead of leaving the model stuck | `frontend/src/lib/server/agent-config.ts` |
| Tunnel gate: non-local Host must present `AGENT_TOOL_SECRET`, fail-closed | `backend/app/main.py`, `backend/app/config.py` |
| `X-Echo-Tool-Token` on every REST tool | `frontend/src/lib/server/agent-config.ts` |
| `start.ps1 -Tunnel` — cloudflared, generates the secret, probes from outside | `start.ps1` |
| 10 backend + 9 frontend tests pinning all of it | `tests/test_conversation.py`, `tests/agent-tools.test.ts` |

**The greeting is composed by `utterance.joined`, not Agora's
`greeting_message`.** That field makes the Fast Loop *model* write the
greeting, and the model is the component §6 does not trust. Routing it through
the same gate means the first thing anyone hears has passed the same check as
everything else Echo says. It also states its own capability honestly: without
the Ledger it says so on arrival rather than refusing twenty minutes later.

**Why the tunnel needs a token.** A tunnel does not expose one endpoint — it
exposes `/incident/reset`, `/bridge/say` and `/approval/redeem` too. A random
`trycloudflare.com` hostname is obscurity, not authentication. The gate is
**fail-closed**: tunnel up and secret unset means every remote request is
refused, because the alternative is a public unauthenticated way to make Echo
say things on a live bridge that looks like it is working correctly.

**A test bug worth keeping written down.** The first run of
`test_conversation.py` failed with `/health` returning 503. The cause was that
`from app.main import app` sat *inside* the first `mock.patch.dict(os.environ,
...)` block, so `load_dotenv()` ran within the patch — and restoring on exit
deleted every credential dotenv had just loaded. The import is now at module
level with a comment saying why.

**Three more defects the live run exposed, all invisible from the console.**

**1. The demo's headline guess was attributed to nobody.** The board read
`[GUESS] Redis might be evicting keys — unknown`. `validate_extraction` drops
claims with an EMPTY `speakerRole`, and its own comment said inventing
"unknown" would launder an unsourced claim — so the model wrote the literal
string `"unknown"` and sailed through the non-empty check. Placeholders are
now named (`unknown`, `n/a`, `none`, `speaker`, `?`, `-`, …). When exactly one
person spoke in the window the claim is attributed to them, which is a
deduction from the transcript rather than an invention; otherwise it is
dropped as before. The match is anchored so "Unknown Systems Lead" survives.

**2. Echo was handed the one Groq key with no budget left.** The Slow Loop
rotates across every configured key. Agora's create-agent payload carries
exactly ONE `llm.api_key`, and Agora calls Groq itself, so the Fast Loop
cannot rotate. Groq's free tier is 200k tokens/day scoped per key AND per
model, so when the first key's budget went, the dashboard kept filling — and
Echo answered every turn with Agora's `failure_message`.

The pre-flight said GO throughout, because `/health/model` asks `groq_json`,
which rotates. **The pre-flight was answering a different question than the
one that mattered**: "reachable on some key" rather than "reachable on the key
Agora will be given, reserving what a real turn reserves". A 16-token probe
fits in budget a 512-token turn does not; measured directly, key #1 was at
`Used 199806 / Limit 200000`.

`selectFastLoopModel` now probes (key, model) pairs at invite time and hands
over one that answered. The invite response reports `fastLoop.keyIndex` and
`voiceVerified` — the index, never the key. `GET /api/health?voice=1` exposes
the same check, and the pre-flight has an eighth line: **"Echo can answer out
loud"**. First run after the fix picked `openai/gpt-oss-20b`, correctly
routing around the exhausted primary.

**3. `failure_message` made Echo blurt at every cough.** One run recorded five
"One moment."s into an otherwise silent channel. The cause is the prompt
working: Agora's recogniser emits turns for non-speech, the model is invoked
with an empty user message, and under "default is ABSOLUTE SILENCE" it
correctly returns nothing — which Agora reads as a failure. **The better the
model obeyed §14.1, the more filler it produced.** Now `""`; verified live
that Agora accepts it and the channel stays silent. A real outage is still
visible through `voiceVerified` and the pre-flight, neither of which depends
on someone noticing a phrase in a busy room.

**The start script then lied about the tunnel, twice over.** Reported
immediately: a plain `.\start.ps1` with a tunnel already live printed "Echo
cannot read the Ledger, restart with -Tunnel". It could read it perfectly
well. The closing message keyed off `$tunnelUrl`, which is set only when THAT
invocation opened a tunnel, rather than off whether one is actually live.

The same bug had a silent and worse half: cloudflared exits, `.env.local`
keeps the dead URL, and the next invite creates an agent WITH tools pointed at
a host that no longer resolves. Every tool call then fails, and a tool that
always fails is worse than an absent one — the model retries, collects errors,
and falls back on its own memory. That is the exact hallucination this product
exists to prevent, arriving through the component meant to prevent it.

The configured URL is now the source of truth and is probed every run. A URL
that does not answer is cleared, both halves of the credential pair with it,
and the console is restarted so it stops handing the dead value to Agora.
Verified by killing cloudflared with the URL still configured: the script
detected it, cleared it, and the next invite correctly reported
`toolsEnabled: false` rather than pointing tools at nothing.

**A PowerShell rule worth keeping.** Fixing the above broke the whole script
with `Missing closing '}'` errors dozens of lines from the actual mistake. The
cause was one em-dash inside a `Write-Note` string. PowerShell 5.1 reads a
`.ps1` without a BOM as ANSI, so U+2014 decodes to CP1252 `0x94` — which is a
right curly quote, and PowerShell accepts curly quotes as string delimiters.
The literal ended early and the parse cascaded. Comments are safe because they
run to end of line, which is why the file's box-drawing headers were never a
problem. **Keep string literals in `.ps1` files pure ASCII**; there is now a
comment in `start.ps1` saying so.

**"ECHO CANNOT SPEAK - the Slow Loop never received the agent id".** Reported
live, and it was two bugs sharing one missing line. Zone 2's invite is
idempotent per channel and the reuse branch returned early without registering
anything.

The loud half: the response carried no `registeredWithSlowLoop`, so the
console read `undefined`, took it for false, and raised that banner over an
Echo that was working perfectly.

The silent half is worse. The active-agent map lives in the Next.js process
and the agent id lives in the Python one. Restart Python alone and it has
forgotten the id while the map still says "already handled" - so every rejoin
short-circuits, the Slow Loop never learns the id, and Echo is mute for the
rest of the session with no cure but a different channel. `start.ps1 -Tunnel`
restarts both services, so anyone who presses J in that two-second window
walked straight into it.

The reuse path re-registers now, with three retries over ~3s so a service
coming back up does not cost the session. Re-registration is safe because the
greeting is suppressed two ways: the Slow Loop skips it when the id is
unchanged, and Zone 2 passes `greet: false` on reuse - which the Slow Loop
cannot decide for itself, since it holds the id in memory and therefore treats
every agent as new after a restart.

**And the greeting was interrupting itself.** Agora recorded the arrival line
truncated to the single word "Echo". `speak_now` interrupts before speaking,
which is right for a contradiction pre-empting the room and wrong for the
first thing said - there is nothing to pre-empt, so the interrupt raced its
own utterance. Now plain `speak(force=True)`. Verified across three
registrations including a mid-test backend restart: greeted exactly once, in
full.

**Sep 4 - `validate.ps1`, and the defect it found on its first honest run.**
"Is it working?" took five commands and five outputs that did not agree on
what counts as working. `.alidate.ps1` now runs 28 checks against the LIVE
system - real agent, real incident, Agora's own history, the tool endpoint
called the way Agora calls it, the auth gate attacked from outside - and
prints one verdict.

Writing it cost three of my own harness bugs before it accused the product of
anything, which is the lesson restated: `$web` and `$WEB` are the SAME
variable in PowerShell, so assigning the parsed health JSON blanked the base
URL and every later call built a hostless URI; `unittest discover` was run
from the repo root instead of `backend/`; and the settle-loop stopped after 4
seconds of `inFlight == 0`, which Demo Script v2 satisfies in each of its 9,
11 and 17 second gaps - so it measured mid-feed and reported claims missing
that arrived seconds later. **That last one is the third time this project has
mistaken a pause for an ending.**

Once the harness was honest it found a real one. `retrieve` ranks candidate
pairs by similarity, and both the engine loop and the pipeline loop returned
on the FIRST actionable verdict - so arrival order decided which finding the
room heard. Act 1's "carts empty" vs "latency is through the roof"
adjudicated INDEPENDENT (correctly: different properties), Echo announced
that, and the loop stopped. The pair the demo turns on - "the cache is fine"
vs "cache read timeouts" - was never reached. **The headline moment was being
lost about one run in two, and it looked like model flakiness.**

OPPOSED now short-circuits both loops; anything weaker is held while the
remaining candidates are checked. The extra spend lands only when the first
hit was the weaker kind. `PANEL_PAIR_BUDGET` still caps panels underneath, so
the ceiling that caused the 429 storm is untouched, and §5.1's
one-interruption-per-window still holds - what changed is which one.

**Three consecutive 28/28 PASS runs afterwards**, the headline contradiction
firing in every one, adjudicated by two different models each time.

**Sep 5 - the conversational loop cannot be automated, and now we know why.**
Probed every plausible shape against the live API. `/agents/{id}/update`
accepts `instruction`, `system_message` and `user_message`, returns 200 for
all three, and voices NOTHING - re-confirming the earlier finding, this time
with tools enabled, so "the model had nothing it was allowed to say" is ruled
out. `/chat`, `/message`, `/input_text` and POST `/history` are all 404, "no
Route matched with those values".

**A conversational turn starts with real audio or it does not start.** That is
a property of the platform, not a gap here - so the right response was to make
the human-in-the-loop check excellent rather than to keep hunting for an API.

`npm run demo converse` streams Agora's own transcript while you talk and
names which of four indistinguishable failures happened: no turns at all (the
audio never arrived), turns with empty text (ASR ran and heard nothing), Echo
refusing (heard you, cannot read the Ledger), or Echo answering.

**It lied on its first run and had to be fixed.** It reported "THE
CONVERSATION LOOP IS CLOSED" during a run where nobody had spoken - it had
counted Echo's own proactive contradiction interventions as answers. Agora
marks those `metadata.start_type == "api_speak"`; the check now discounts them
and prints "(Echo speaking on its own)", and additionally refuses to declare
the loop closed unless a USER turn was heard first. **Fifth time a harness
here confirmed what it was hoping for.**

`validate.ps1` now prints what it does NOT cover on every PASS. A verdict that
implies more than it tested is worse than no verdict.

**The referee fired live** on the Sep 5 run: SKEPTIC INDEPENDENT 0.71 vs
SEEKER OPPOSED 0.95, split, and qwen/qwen3.8-27b settled it OPPOSED 0.95 -
three models, which is the §7a design working exactly as intended and the best
evidence yet that the panel is not decoration.

**Sep 5 (later) - the SDK is the spec, and reading it settled three things.**
You reported the official quickstart working for both listening and talking,
and `npm run demo converse` gave the first real signal from a human: a turn
WAS segmented and came back **transcribed empty**. So I installed
`agora-agents` and read the wire shape instead of inferring it.

1. **Managed LLM.** `OpenAI(model="gpt-4o-mini")` carries no api_key - Agora
   supplies and bills it, removing the constraint that sent this project to
   Groq. `AGENT_LLM_MODE` now selects managed (default) or groq.

2. **What managed actually looks like on the wire.** Not what I first wrote.
   `to_config()` emits the OpenAI url, but `strip_inferred_preset_fields()`
   then removes `url`, `api_key` and `params.model` once the preset has been
   INFERRED from them. `preset` is composed per managed category and
   comma-joined - `deepgram_nova_3,openai_gpt_4o_mini`. Sending an api_key
   alongside a managed model makes `infer_llm_preset` return null and
   silently drops the agent off the managed path.

3. **The ASR "fix" that would have broken it.** `DeepgramSTT.to_config()` puts
   `language` inside `params`, so I moved ours there. Then `agent.py`:

       # Unconditional: turn detection is the single source of truth for the
       # interaction language, so a vendor-level `language` would be silently
       # discarded here.
       asr_config["language"] = field(turn_detection_config, "language")

   Top level, from turn detection - which is what we already had. **The ASR
   config was correct all along and I reverted my own change.** `en-US` is the
   SDK's own DEFAULT_TURN_DETECTION_LANGUAGE, so that is right too.

   Dropped `advanced_features.enable_aivad`, which the quickstart does not
   send and we had no reason to.

**So the empty transcript is not a payload defect.** Everything Agora is given
now matches the SDK's own output. The remaining candidates are the microphone
the browser actually captured, speaking level, or speaking over Echo's
greeting - which is what `converse` is built to tell apart.

**Tests: 198 backend + 124 frontend = 322.** Validation 28/28.

**Sep 6 - "why is it not speaking": the agent was dead and nothing said so.**
Checked the live state rather than theorising. `/health` reported agent
`A44CT84...` on `inc-4417`, `degraded.voice: false`, everything green - and
Agora's own status endpoint said **STOPPED**.

`idle_timeout` is 300s and Agora counts idleness in the CHANNEL, not in our
pipeline. The documented demo flow walks straight into it: press J (a few
seconds of audio), run `demo feed` - which posts transcripts to the Slow Loop
over HTTP and puts NO audio in the channel - then read the prompt, then speak.
Five minutes of channel silence is easy to reach before the first word.

Agora stops the agent, and every surface we own keeps saying it is fine: the
id stays registered, `/health` reports it, the degradation banner stays clear.
**Echo was not refusing to speak. Echo was not there.**

The pre-flight now asks Agora rather than itself - "the registered agent is
alive on Agora" - and `demo converse` checks before asking anyone to talk.

**And a bug in my own fix, caught before it shipped.** The first version
auto-re-invited with `userUid: 1001`. The Roster allocates sequentially and
hands the browser whatever is next; one earlier probe puts the real listener
on 1002. Agora subscribes to exactly ONE uid, so that agent would join, report
RUNNING, and hear nobody - the silently-deaf failure that has already cost
this project days. Only the browser knows its own UID, so `converse` now
CLEARS the stale agent (which the idempotent invite would otherwise hand back)
and tells the operator to press J. Clearing is the part a script can do
correctly; inviting is not.

**Still not verified by a human mouth.** Everything up to the microphone is
proven: ASR runs (`source: "asr"` in Agora's history), tools are reachable
when the tunnel is up, the LLM is wired to Groq, TTS speaks. Whether a real
spoken question comes back as a spoken answer needs someone to say it out
loud — `npm run demo speech`.

**Tests: 198 backend + 118 frontend = 316.**

---

### Sep 5, 2026 — "not listening, not speaking" was a ghost in the registry

User report mid-session: Echo neither listened nor spoke, then later "I just
hear myself back." Both traced to ONE root cause and one secondary.

**The ghost agent (the whole signal).** Every live symptom since ~17:19
came from the invite path reusing a corpse. The channel's agent had been
ended by Agora (idle timeout / vendor failure); the Next-process map and the
Slow Loop's registry both kept its id, and Agora's own read surface said so
loudly if anyone asked — it did not, so nobody did. `/bridge/say` ultimately
proved it: Agora answered `404 TaskNotFound` for the id `/health` reported as
live. Every later "invite" logged `200 in 23ms`: that is the reused-corpses
signature (a real create takes ~13s).

Command used to reproduce: `POST /bridge/say` then read Agora history —
one blank turn (`content: ""`, the % silence rule holding; see the
`"[Silence]"` entry) and zero speech, on an agent `health` called live.

**The fix (frontend, `invite-agent` route).** Before reusing the map entry,
the route now probes Agora: `GET /agents/{id}`. 200 = reuse; 404 matching
`TaskNotFound|has already ended|failed to start|not found` = evict and create
a fresh agent; anything else (network error, 5xx, non-404) = fail closed and
KEEP reusing, because evicting on ambiguity risks two consoles summoning two
Echoes in one room (§18). A mute Echo is recoverable; two Echoes argue. The
liveness probe lives in the route, not `active-agents.ts`, because that module
is loaded by plain `node --test` and must stay free of `@/` aliases.

**The secondary (unresolved): "hearing myself back."** With the corpse as the
only "Echo", the room contained no agent — two of the user's own consoles
(console on :3001 + the tunnel-exposed URL) would each play the other's mic,
which is exactly "everything I say, I hear back." Not confirmed, because a
live Echo was not in the room at the time. Next symptom-gate: once a fresh
agent greets, if loopback persists WITH a live agent subscribed, trace audio
with the volume indicator + Agora history rather than theorising. Also: this
machine's network reaches `api.agora.io:443` but the RTC media-plane
bootstrap failed with `multi unilbs network error, retry NETWORK_TIMEOUT` on
every browser join until the Fortinet SSL-VPN was dropped — REST and media
take different paths, and `validate.ps1` passes on REST alone.

**352px voice column cannot carry a long conversation.** Added T / expand
button (`TranscriptFeed`): full-chronological transcript overlay of
everything heard so far, closes on Esc / X / backdrop. Same renderer as the
live feed, so review == live.

**Tests: 198 backend + 125 frontend = 323.** Frontend gates green.

---

### Sep 06 — the transcript subscription was never opened

**Symptom:** the agent did not react to the mic. Zero `[voice-agent] update`
lines in the browser console. Everything else looked healthy — the agent
joined, the mic published, Agora's own `/history` segmented turns.

**Cause, and it is one line.** `AgoraVoiceAI.init()` **binds no listeners.**
Read `_doInit` in `node_modules/agora-agent-client-toolkit/dist/index.mjs`: it
validates the engines, assigns `rtcEngine` / `rtmEngine` / `renderMode` to the
singleton, and returns. That is all it does.

The only call that reaches `bindRtcEvents()` — and therefore the only call
that ever attaches

```js
rtcEngine.on("stream-message", this._boundHandleRtcStreamMessage)
```

— is **`subscribeMessage(channel)`**. It also starts the render controller
that turns those frames into `TRANSCRIPT_UPDATED`. We never called it.

So `on(TRANSCRIPT_UPDATED, ...)` was registering a handler on an emitter that
nothing would ever emit into. No error, no warning, no rejected promise. The
toolkit's own documented example shows both calls in order:

```ts
const api = AgoraVoiceAI.init({ rtcEngine, rtmEngine, renderMode });
api.subscribeMessage('channel-id');   // ← this line
```

**Why the previous fix looked right and still failed.** The session before
this one correctly diagnosed the *transport*: transcripts travel on the RTC
data stream, not RTM, and it moved off the hand-rolled RTM listener onto the
toolkit for exactly that reason. That diagnosis was right. But moving to the
correct transport and then never opening it produces the identical symptom —
which is why the second failure hid so cleanly behind the first.

**Fix:** `voice-agent.ts::start()` now takes the channel and calls
`this.ai.subscribeMessage(channel)` after the handlers are registered.
`agora-bridge.ts` threads the channel through.

**Pinned in source**, since the failure is silent by construction:
three tests in `tests/agora-transcript.test.ts` assert `subscribeMessage` is
called, is called with `channel`, and is called *after* the
`TRANSCRIPT_UPDATED` handler is registered. Verified by reverting the fix and
watching two of them fail.

> **The general lesson, and it has now cost this project twice:** with this
> toolkit, "configured" and "subscribed" are separate steps, and skipping the
> second is indistinguishable from a deaf product. If transcripts are missing,
> check that `subscribeMessage` ran **before** re-examining the agent payload.

**Tests: 198 backend + 128 frontend = 326.** Typecheck, lint and build green.

### Session 7 — the headline contradiction was silently not firing (Sep 6)

**Ask:** get the project demo-ready against the hackathon problem statement.

Mapping the ten required capabilities onto the code found eight already built
and verified. Two were not, and the first one mattered a great deal.

#### The contradiction never reached a panel

A clean live run — reset, GO pre-flight, full feed — produced claims, gaps and
a timeline, and **zero contradictions**. Nothing errored. The dashboard simply
sat at `00 CONFLICTS` while the Ledger held both halves of the conflict.

`ContradictionEngine.scope` required `c.entity == new.entity`. Extraction files
each claim under exactly ONE entity, and the two claims the whole demo turns on
had landed on different ones:

| claim | text | entity |
|---|---|---|
| c6 | "The cache is fine" | `e2` Redis |
| c7 | "cache read timeouts on the checkout path" | `e1` checkout |

c7 names two systems and the extractor had to pick one; it picked checkout. So
`scope` returned `[]`, no panel ran, and the pair was never compared. The Aug 31
work had made the *panel* reliable at judging that pair — this bug meant the
panel was never asked.

**The fix is in `scope`, not in extraction.** A claim is about every system it
NAMES, not just the one that won the extractor's tie-break, so a candidate now
also qualifies when one claim names the other's entity. Tuning the extraction
prompt to file c7 under Redis would have been asking a model for a guarantee it
cannot give (Rule 8); this is structural.

The row-4 precision guard survives, and deliberately: mention is *required*, so
"Redis memory 40%" and "Postgres memory 40%" still never pair, because neither
sentence contains the other's name. Widening recall is also the cheap direction
to be wrong in — Stage 3's Panel still decides, and it is tuned to refuse
OPPOSED. Four tests pin all of it, including a substring guard
("redistribute" must not match "redis") and a no-alias-table case proving old
callers are unaffected.

After the fix, same script: **OPPOSED, unanimous, 94% confidence** — "The
presence of cache read timeouts directly contradicts the assertion that the
cache is fine."

#### Ownership was a feature the demo never showed

Tasks with `assigneeRole` were fully implemented and the Tasks panel stayed
empty for the entire script, because none of the four lines assigned anything.
Added Act 3 — the DevOps Lead assigning the connection-pool check to the
Database Admin, spoken by the Lead so it needs no third UID and no third
machine. It also closes on Act 1's unchecked assumption.

Echo files the assignment as `INFERRED`, so it shows on the dashboard and is
filtered out of the voice channel. That is Rule 3 working, not a bug.

#### Verified this session, against the API and a real browser

Close-out speaks and ends on "Root cause is not established"; a verbal "yes"
returns `authorized:false`; ADVISORY tools execute (`INC-0001`) while both
CRITICAL tools return `PENDING_APPROVAL` — "voice cannot authorize this" — and
a replayed Jira call comes back `DEDUPED`.

#### Rule 7 earned its place three times in one session

None of these were product defects, and each looked exactly like one:

1. `/get_config` returned **404** and `/api/health` returned **308**. This
   environment sets `HTTP_PROXY=http://127.0.0.1:58080`, which `curl`,
   `requests` AND `urllib` all honour. `trust_env=False` (or a `ProxyHandler({})`
   opener) turns the same call into a 200.
2. A headless screenshot showed a completely empty board. `--virtual-time-budget`
   fast-forwards timers and captures before the real WebSocket round-trip lands.
   Asserting the SNAPSHOT directly over `ws://` showed the server had everything.
   **Screenshots of this app must be driven over CDP with a real wait** — and
   the socket only opens after **J**, by design, so an unjoined page is
   correctly blank.
3. The close-out summary printed `4 items � 1`. That is a U+2014 em dash the
   Windows console cannot render; the wire bytes decode as strict UTF-8.

#### ECHO WAS DEAF — `asr.params` had no `language`, and three params too many

`npm run demo speech` returned **"NOTHING ARRIVED"**. Agora recorded 44 turns,
22 carrying text, and the text was Echo's own greeting plus `[Silence]`.

That combination is the whole diagnosis: **VAD was segmenting correctly** — 44
turns is not a microphone that never opened — and the recogniser produced no
words. The fault was in `asr`, not the mic, not the tunnel, not the roster.

The `agent-quickstart-python/` clone in this repo is the control group: same
Agora project, same App ID, and it transcribes. So the shapes were compared as
bytes rather than as intentions, by running the SDK:

> **Sep 8:** that clone was deleted — 33,000 files on disk (100 tracked, the
> rest a vendored venv and a web app) for the two files anyone read. Nothing
> is vendored now; the comparison below stands, and its sources are upstream:
>
>     github.com/AgoraIO-Conversational-AI/agent-quickstart-python
>       -> server/src/agent.py
>     the installed agora-agents SDK
>       -> agora_agent/agentkit/presets.py   (python -c "import
>          agora_agent.agentkit.presets as p; print(p.__file__)")
>
> Note the second was never IN the clone — it ships inside the pip package,
> which the README used to cite as though it were quickstart source.

```
DeepgramSTT(model="nova-3", language="en").to_config()
_resolve_asr_config()        # adds TOP-LEVEL language from turn detection
resolve_session_presets()    # infers deepgram_nova_3 FROM params.model,
                             # strips params.model, KEEPS params.language
```

| | works | EchoSphere (deaf) |
|---|---|---|
| `preset` | `deepgram_nova_3,…` | `deepgram_nova_3,openai_gpt_4o_mini` ✅ |
| `asr.params` | `{language:"en"}` | `{keyterm, smart_format, punctuation}` ❌ |
| `asr.language` | `"en-US"` | `"en-US"` ✅ |

**`params.language` was missing.** It had been deleted on the reasoning that
"the session layer overwrites it from turn detection afterwards, so params is
exactly where it gets thrown away." That is not what the SDK does:
`_resolve_asr_config` assigns `asr_config["language"]`, the TOP-LEVEL key, and
never touches `params`. Both fields are on the working wire and they are not
the same field — one is the interaction language, the other is what reaches
Deepgram. Note also `en` vs `en-US`; the file's own comment already said `en`
while the code sent `TURN_DETECTION.language`.

`keyterm` / `smart_format` / `punctuation` were also removed: none appear in
any payload observed to transcribe, and `keyterm` was one space-separated
string. Agora validates only `vendor` and forwards `params` unchecked — the
trap already documented for `tts` — so a param the managed adapter dislikes
takes the recogniser down silently. Re-add them one at a time, running
`npm run demo speech` after each.

`buildAgentPayload` now emits the proven shape byte-for-byte, asserted by
`scripts/dump-payload.mjs`, and two tests pin it: `params.language === "en"`,
and `Object.keys(params) === ["language"]` as a floor against re-adding an
untested option.

**Not yet confirmed by a human voice.** Agora accepts the corrected payload
(agent created, `voiceVerified: true`), but only someone speaking into a
microphone can close this out — `npm run demo speech`.

#### CORRECTION — `"*"` IS a wildcard, and believing otherwise made Echo deaf to the room

Three people joined on three machines, could all hear each other, and **Echo
heard none of them**. This is the second half of the deafness, and it is a
correction to a decision this log previously recorded as a fix.

`agent-config.ts` sent `remote_rtc_uids: [String(params.userUid)]` — one
person — justified by a long comment asserting that `"*"` is "read as a user ID
literally named `*`, which nobody has". A test pinned it. **The assertion is
false.** Agora's documentation for the field:

> "The `*` selector includes all UIDs present in the channel, which may include
> other AI agents."
> — docs.agora.io/en/conversational-ai/rest-api/join

Confirmed against the live API as well: `["*"]`, `["1001"]` and
`["1001","1002","1003"]` are all accepted and all start a running agent. The
`agora-agents` SDK docstring still says "currently, only one user ID is
supported" — **it is stale**, and trusting it over the docs is what started
this.

**Why the original `["*"]` trial looked like it failed.** It was run while the
`asr` block was broken (no `params.language`, plus a `keyterm` the managed
adapter would not take), so nothing was going to transcribe no matter who the
agent subscribed to. Two independent bugs; the wrong one was convicted, and the
conviction was then written into a comment and a test that kept it alive.

**Nothing else needed changing.** `forwardDecision` already has each browser
forward ONLY its own speech under its own role, so three speakers produce three
correctly-attributed streams with no duplicates. The multi-participant design
was already there and had one field throttling it.

One consequence worth knowing: `idle_timeout` fires when everyone in
`remote_rtc_uids` has left, and under `"*"` a stray agent in the channel counts
as somebody — so `npm run demo reset` matters for more than tidiness.

The lesson is the one Rule 7 keeps teaching in a new costume: **two bugs at
once will frame each other.** When an experiment fails, check that the thing it
was testing was the only variable.

**Tests: 202 backend + 125 frontend = 327.**

---

### Session 8 · Sep 8 — deleting the code that had no caller

Backend cleanup, phase 1 of the rework plan. **No frontend file was touched**,
and the HTTP/WS contract is unchanged.

**What went, and why.**

`rti.py` + `POST /rti/observe` + `utterance.tension_intervention` +
`test_rti.py` — **the Room Tension Index had no producer.** The module was
correct: normalized terms, EWMA, Schmitt trigger, 90s cooldown, all as §8
specifies, all unit-tested. But computing it needs one 200ms slice of per-UID
RMS and F0 per participant, and the only thing that can supply that is the
native Agora server SDK — the S2 blocker. Nothing in the repository ever posted
to the endpoint: not the console, not `demo.mjs`, not any Rig tier, not
`validate.ps1`. The dashboard's `TensionMeter` rendered `state.rti`, and the
value was always the reducer's initial `0`.

`Ledger.rti` and the snapshot's `rti` key deliberately **stay at `0.0`** —
`types.ts` still declares the field and the console still reads it, so removing
it from the wire would have been a frontend change.

`POST /ledger/claim` and `POST /ledger/unchecked` — no caller, and a liability
rather than dead weight. Claims are meant to enter through extraction, which
applies the hedge guard, entity resolution and the unsourced-claim drop. These
bypassed all three, and because the tunnel exposes the whole service they were
a writable path into the evidence record.

`POST /bridge/contradiction` — a **second implementation of W3**, the headline
workflow, with no caller and already drifted: it took `relation` from the
request body and recorded no panel verdict, while the real path
(`_surface_contradiction`) carries the Deliberation Panel's positions and
dissent. Two implementations of the behaviour the product is built around is
how they diverge unnoticed.

`config.analysis_model()` and `config.groq_api_key()` — superseded singulars,
no callers. Actively misleading: one key implied where rotation across several
is what actually happens, one model implied where the fallback chain is what
keeps the pipeline alive on an exhausted daily quota. Also dropped the now-dead
`import time` from `main.py`.

**What was added.** `tests/test_contract.py` — pins the served path set against
the list of routes with external callers, each annotated with its caller. That
list was not self-evident from the code; it had to be recovered by grepping
every caller in the repo, which is how the four orphans surfaced. It also
asserts the deleted routes have not come back, so a merge cannot quietly
restore them. Written and confirmed FAILING before the deletions, so it is a
real guard rather than a tautology.

**How it was verified — and the part that matters.** A green suite proves
nothing here (Rule 7). So: the server was booted, `/health` returned
`ready: true`, the four deleted routes returned 404 and the kept ones did not,
four utterances were fed through `/observer/transcript`, and the Ledger was read
back through `query_incident_state`. The hedge stayed out of the facts
("Datadog looks like Redis might be evicting keys" → `HYPOTHESIS` @ 0.80, not
`OBSERVED` @ 1.00), every claim kept its speaker, and the panel adjudicated the
headline pair OPPOSED at 0.90 unanimous across two models. Rig **Tier 3: 12/12
clean.** WebSocket HELLO returned a SNAPSHOT with `rti: 0.0` present.

**Tier 2 scored 67% contradiction detection — and so did the pre-change code.**
That number looked like a regression, so rather than assume, a git worktree at
`HEAD` was scored with the same venv and the same scenario: identical 67%,
identical 33% fully-correct runs, and the *same two* failure modes (unexpected
pair on carts-vs-latency; entity split on 40-percent-vs-timeout). Pre-existing
model variance, matching the README's documented "~2 runs in 3". **The lesson
is procedural: when a metric looks bad after a change, measure the same metric
before the change on the same machine before believing it.** A worktree makes
that cheap.

**Tests: 199 backend + 125 frontend.** Backend went 213 → 199: −14 RTI tests,
−1 tension composer test, +3 contract tests, and net line count is down ~900.

### Session 9 · Sep 8 — splitting main.py, and the bug it exposed

`main.py` 1,480 → 112 lines. No frontend file touched; the HTTP/WS contract is
unchanged. Behaviour-preserving by intent, and the two places it was NOT are
recorded below because both were real defects.

**The shape.** Three layers with one rule — *routes do no work, services own no
transport*:

    app/routers/     7 modules, 24 handlers. Transport only.
    app/middleware.py  the tunnel gate, out of main
    app/services/    session, pipeline, speech, budget. No FastAPI import.
    app/adapters/    agora_bridge, agora_agent. The network boundary.
    app/deps.py      pooled HTTP client + session lookup
    app/*.py         the domain, untouched (ledger, extraction, panel, …)

`bridge.py` → `adapters/agora_bridge.py` and `voice_agent.py` →
`adapters/agora_agent.py`, both via `git mv` so history survives as a rename.
`IncidentSession` replaces the eight module globals, and `/incident/reset` is
now "build a new session" rather than five `global` rebinds plus
`engine._cooldown.clear()  # noqa`. `ContradictionEngine.reset()` is public
because of that.

**Two defects the refactor created, and how they were caught.**

*1 — dashboards would have gone silent after a reset.* Per-session state means
a new session builds a new `DeltaHub`, but every connected browser is parked on
`queue.get()` for a queue from the OLD hub. Publishing to the new hub reaches
nobody. Fixed with `DeltaHub.adopt`, which moves the live subscribers across so
the parked handlers keep working with no reconnect. Caught by reasoning about
the reset path, not by a test — worth a test if this is touched again.

*2 — Tier 3 failed run 2 of 3, and it was NOT model variance.* The failing
check was "hypothesis kept OUT of established", the most important one in the
suite. The instinct was to call it the documented ~2-in-3 flakiness. That would
have been wrong.

`/health` reported `pipeline.inFlight` from the CURRENT session only. A
pipeline task spawned moments before a reset keeps running against the old
session, where its task handle lives — so `inFlight` read 0, Tier 3's `busy()`
probe concluded the pipeline was idle, and it asserted while an extraction was
still writing. The claim was late, not missing. Before the refactor a single
module-global task set made this true by accident; per-session state broke it.

Two fixes: `registry.total_in_flight` counts retired sessions too, and a reset
now CANCELS the previous incident's in-flight analysis — a reset means that
incident is over, and letting a straggler finish would republish the discarded
run's claims onto a freshly cleared board.

**How it was proven, and the method that mattered.** The baseline was scored
first: a `git worktree` at `HEAD`, same venv, same machine, Tier 3 ×3 → 12/12
three times, S6 gate met. Mine failed run 2. That asymmetry against a known-
flaky suite is what justified digging instead of shrugging. After the fix:
3/3 clean, gate met. Also verified the hedge guard in isolation — fed the
Datadog hedge alone, got `HYPOTHESIS` @ 0.80 with `established` empty.

**A trap worth naming: `test_contract.py` was silently passing on nothing.**
This FastAPI version's `include_router` appends a deferred `_IncludedRouter`
placeholder carrying no `.path`, expanded only when a request is matched. So
`{r.path for r in app.routes}` — the obvious implementation — returned four
paths (`/docs`, `/openapi.json`, …) and the contract test would have passed
while every real route was missing. It now walks `original_router` and
`include_context.prefix`, and finds 24. The route-inventory test exists
precisely to catch a lost route during this refactor; it nearly became the
thing that hid one.

**Also removed:** `backend/venv/` (an empty Python 3.12 venv, 0 packages, a
gitignored leftover from the SDK attempt — not to be confused with the real
`.venv/`) and `start_app.txt` (a tracked one-line scratch note whose content is
already in the README).

**Tests: 199 backend + 125 frontend, both green. Tier 3: 12/12 ×3.**

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
6. **Don't assume `init()` subscribed you.** With
   `agora-agent-client-toolkit`, `init()` only stores config —
   `subscribeMessage(channel)` is what binds `stream-message`. Configured and
   subscribed are two steps, and skipping the second looks exactly like a deaf
   product. Cost this project a full session on Sep 06.
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
