# EchoSphere — Real-Time AI Incident Commander

**Echo** joins a live voice bridge during an outage, organises what people say
into a knowledge graph, separates confirmed facts from assumptions, surfaces
contradictions, tracks who owes what — and **never determines the root cause
itself.**

That last clause is not a limitation we apologise for. It is the product.

> Most AI incident tools will tell you the root cause. This one tells you what
> you actually know, who established it, and what nobody has checked.

Two consequences of taking that seriously:

- **Echo shows its working.** Contradictions are judged by a panel of AI
  analysts with deliberately opposite biases, on different models. When they
  disagree, you see the disagreement — a contested verdict is a weaker thing
  to act on than a unanimous one, and hiding that would be Echo overstating
  its own certainty.
- **Echo can be told to stop listening.** Say *"off the record"* and it stops
  minuting until someone says otherwise. Suspended turns are counted, never
  stored.

---

## The problem

A Sev-1 bridge call is twenty people talking at once. Within ten minutes
nobody can tell you three things:

1. **What has actually been observed**, as opposed to guessed. Somebody says
   *"Datadog looks like Redis might be evicting keys"* and forty minutes later
   the room is debugging Redis, because a hedge hardened into a fact the
   moment it was repeated.
2. **Who established what.** Claims lose their owner as they are relayed, so
   nobody can go back and check.
3. **What nobody has checked.** The gaps are invisible precisely because
   nobody is looking at them.

Meanwhile two engineers state things that cannot both be true — *"the cache is
fine"* and *"cache read timeouts on checkout"* — and it goes unnoticed for
twenty minutes, because they are describing different properties of the same
component and each assumes the other is talking about something else.

**Echo listens to the bridge and fixes exactly those three things.** It does
not diagnose. The brief's own closing clause is *"without pretending to
independently determine the root cause"*, and that is treated here as the
grading rubric rather than a caveat.

---

## Agora Conversational AI integration

Mandatory for this submission, so here is precisely what is used and where.

| Agora capability | Where it runs | What it does here |
|---|---|---|
| **Conversational AI Engine** | `frontend/src/lib/server/agent-config.ts` | Builds and starts the cloud agent. Echo is a real participant with its own UID (9000). |
| **Managed ASR** — Deepgram `nova-3` | `preset: deepgram_nova_3` | Transcribes the bridge. Domain terms boosted via `asr.params.keyterm`. |
| **Managed LLM** — OpenAI `gpt-4o-mini` | `preset: openai_gpt_4o_mini` | The Fast Loop. Agora supplies and bills the model, so no OpenAI key is needed. |
| **BYOK TTS** — ElevenLabs `eleven_flash_v2_5` | `properties.tts` | Echo's voice. The quickstart's documented BYOK path. |
| **REST tools** | `properties.llm.tools` | Agora calls **our** endpoints mid-turn. This is what stops Echo inventing an incident. |
| **`/agents/{id}/speak`** | `backend/app/bridge.py` | The Slow Loop puts exact, rule-validated words in Echo's mouth. |
| **`/agents/{id}/interrupt`** | `backend/app/bridge.py` | Pre-empts Echo for a high-priority contradiction. |
| **RTM data channel** | `parameters.data_channel: "rtm"` | Transcripts and agent state reach the browser. |
| **Turn detection / VAD** | `properties.turn_detection` | Nested `start_of_speech` / `end_of_speech` config, tuned so Echo does not barge in on breaths. |
| **Agent status + history** | `frontend/src/app/api/agent-status` | Every claim in this README is checked against Agora's **own** record, not our logging. |

### The one that matters: REST tools

Agora's Engine calls tool endpoints **from its own servers**. That single fact
shapes the architecture:

```
  you speak  ->  Agora ASR  ->  Agora LLM  ->  calls OUR /tools/query_incident_state
                                                        |
                                          the same Ledger the dashboard renders
                                                        |
                                            <-  answer  <-  Agora TTS  ->  you hear it
```

Ask Echo what is happening and it performs a real HTTP read against the
incident record. It cannot answer from memory, because the prompt forbids it
and the tool is the only route to the facts.

`127.0.0.1` resolves to *Agora's* machine, so a local run needs a public URL —
`.\start.ps1 -Tunnel` opens one. The tunnel exposes the whole Slow Loop, so
every tool call must present `AGENT_TOOL_SECRET`; the gate fails closed.

### Conformance with the official quickstart

Diffed field by field against `agent-quickstart-python/server/src/agent.py`,
and where the REST shape is not obvious it was read out of the `agora-agents`
SDK rather than guessed:

- `remote_rtc_uids`, `enable_string_uid`, `advanced_features.enable_rtm`, all
  four `parameters`, and the nested `turn_detection` shape **match**.
- `preset` is composed the way `presets.py:resolve_session_presets` composes
  it — one entry per managed category, comma-joined — and the fields that a
  preset covers are omitted, because `strip_inferred_preset_fields` removes
  them. Sending an `api_key` alongside a managed model silently drops the
  agent off the managed path.
- `asr.language` sits at the top level, equal to `turn_detection.language`:
  *"turn detection is the single source of truth for the interaction
  language, so a vendor-level language would be silently discarded."*

Print the exact body we send at any time:

```powershell
cd frontend
npm run payload
```

---

## Quick start

### The short way

From the repository root, in **PowerShell**:

```powershell
.\start.ps1 -Tunnel    # console + Slow Loop + the tunnel Echo needs
.alidate.ps1         # prove it works, end to end, against live Agora
```

`start.ps1` brings everything up and waits until each service genuinely
answers. `validate.ps1` then runs 28 checks against the LIVE system — it
invites a real Agora agent, feeds a real incident, reads what Agora itself
recorded, calls the tool endpoint the way Agora calls it, and tries to get
past the auth gate. It prints one verdict.

A green test suite is not a working product: four real UI defects here once
passed typecheck, lint and build. That is why validation asserts against the
vendor's own records rather than our logging. Then open **http://localhost:3000**, press **`J`**, and run
`npm run demo feed` from `frontend/`. Echo announces itself out loud on
joining — that greeting is your proof the voice path is live.

**`-Tunnel` is what makes Echo conversational.** Agora's Engine calls tool
endpoints from *its own servers*, so `127.0.0.1` is unreachable and without a
public URL the agent is created with no tools at all. Echo can then hear and
speak but has nothing it is permitted to say about the incident, because Rule 3
forbids answering from memory. With the tunnel, "Echo, what do we know so far?"
performs a real read against the same Ledger the dashboard renders from.

The tunnel exposes the Slow Loop publicly for as long as it runs. The script
generates `AGENT_TOOL_SECRET`, and the backend refuses any non-local request
that does not present it — fail-closed, so a tunnel with no secret serves
nothing rather than serving everything. Close it when you are done:
`Get-Process cloudflared | Stop-Process`.

> **Windows note.** Do not chain these with `&&`. Windows PowerShell 5.1 has
> no `&&` operator and treats it as a *parse error* — the command does not run
> and does not explain why, which reads as the project being broken. Use `;`,
> separate lines, or `.\start.ps1`.

### The long way

Three processes. Two terminals plus a browser.

**Terminal 1 — the Slow Loop (Python, Zone 3):**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

**Terminal 2 — the console (Next.js, Zone 2):**

```powershell
cd frontend
npm install
copy .env.local.example .env.local    # then fill it in — see Credentials
npm run dev                           # http://localhost:3000
```

On macOS or Linux the venv binaries live in `.venv/bin/` instead, and `cp`
replaces `copy`.

Then, from `frontend/`:

```bash
npm run demo reset     # clean board, stop any agent left running
npm run demo           # pre-flight — refuses to print GO if anything is off
```

Open **http://localhost:3000**, press **`J`**, wait for the status bar to read
**LIVE DATA**, then:

```bash
npm run demo feed      # speak Demo Script v2 into the live pipeline
npm run demo speech    # or say a line yourself and watch the Ledger
```

`npm run demo` checks seven things that have each gone wrong here and none of
which announce themselves: credentials, both services, a leftover agent from
the last rehearsal, a dirty board, recording left off, a degradation banner,
and whether there is any Groq budget left today.

Check you are wired up before anything else:

```bash
curl localhost:3000/api/health     # want {"ready":true,...}
curl 127.0.0.1:8000/health         # want {"ready":true,...}
```

If the Slow Loop is not running the console still works — it falls back to a
scripted replay and the status bar says **REHEARSAL** rather than **LIVE DATA**.
That is deliberate: a replay must never be mistaken for a live incident.

---

## Credentials

Copy `frontend/.env.local.example` to `frontend/.env.local` and fill in five
values. The backend reads the same file, so you only fill it in once.

| Variable | Where it comes from |
|---|---|
| `AGORA_APP_ID` | Agora Console → Projects (32-char hex) |
| `AGORA_APP_CERTIFICATE` | same project → Configure → Primary Certificate |
| `AGORA_CUSTOMER_ID` / `AGORA_CUSTOMER_SECRET` | Console → **RESTful API** → Add a secret |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `ELEVENLABS_API_KEY` | [elevenlabs.io](https://elevenlabs.io) → API keys (starts `sk_`) |
| `GROQ_API_KEY_2` | *Optional.* A second Groq key. The daily cap is per key AND per model, so this doubles the budget outright — see `backend/app/config.py::groq_api_keys` |
| `AGENT_TOOL_BASE_URL` | *Optional.* Public URL of the Slow Loop, for Agora's REST tools. Agora calls them from its own servers, so localhost does not work. Blank disables tools deliberately |

Two traps that have each cost hours here:

- **The customer ID/secret is a different credential from the app certificate.**
  Tokens are signed with the certificate; the management API uses HTTP Basic
  with the customer pair. Crossing them gives an opaque 401.
- **An ElevenLabs key starts `sk_`.** The 64-hex string shown in the dashboard
  list is the key's *ID*, not the key. The real value is displayed once.

`.env.local` is gitignored and must stay that way.

---

## Running the tests

```powershell
cd frontend
npm run verify        # typecheck -> lint -> 118 tests -> build

cd ..\backend
.\.venv\Scripts\python -m unittest discover -s tests -t .    # 195 tests
```

**No slot is done until `npm run verify` passes.** And a green build says
nothing about whether the UI works — screenshot the running app.

### Measuring quality, not just correctness

```powershell
cd backend
.\.venv\Scripts\python -m rig.tier2 --runs 5 --scenario full-demo
```

The Rehearsal Rig runs the real pipeline over fixed transcripts N times and
**scores** it: contradiction detection, precision, epistemic tagging,
attribution, entity convergence. It exists because reliability cannot be tuned
by watching three demos — every fix in the contradiction engine was chosen by
this number moving.

**Tier 3** goes further and drives the running server the way the demo does —
real endpoints, real Ledger, real deltas, at conversational pace:

```powershell
.\.venv\Scripts\python -m rig.tier3 --runs 3     # needs the Slow Loop running
```

⚠️ **The gate passes 2 runs in 3, not 3 in 3, on Groq's free tier.** The
failing run is always the same: under rate-limit pressure one window returns a
thin extraction and the measurement is missing. No exception, no dropped row —
the model just answers thinly when the budget is thin. Groq's per-minute cap
is per *organisation*, so a second key raises the daily budget and not that
ceiling. A single run — which is what a demo is — passes reliably.

Three *consecutive* clean runs, not an average: the failure it catches is
state leaking between runs, and an average hides exactly that. Tiers 1 and 2
never touch HTTP or the Ledger singleton, and both stayed green through a live
run where the dashboard showed nothing — that is why Tier 3 exists.

It asserts against the **API**, never against rendered text. A DOM-scraping
harness here reported "contradiction surfaced ✓" because its regex matched the
word `CONFLICTS` in the page header.

---

## How it fits together

```text
  browser ──► Next.js (Zone 2) ──► Agora ──► Groq ──► ElevenLabs
     │           Agora creds only        Echo speaks
     │
     └─ RTM transcripts ──► Python (Zone 3) ──► Ledger ──► deltas ──► dashboard
                              analytical keys        │
                                                     └─► Bridge ──► /speak
```

**The invariant:** the Fast Loop never writes to the Ledger, and the Slow Loop
never speaks. Every fact on the dashboard came from human speech; every word
Echo says came from state it was given.

| Where | What |
|---|---|
| `frontend/src/lib/incident-reducer.ts` | **All** state logic. One reducer, no component holds a copy |
| `frontend/src/lib/types.ts` | The wire contract, mirrored by `backend/app/models.py` |
| `frontend/src/app/globals.css` | The design system, heavily commented. Read before writing UI |
| `backend/app/utterance.py` | Composes Echo's exact words — §6 Rules 1–2 enforced in code |
| `backend/app/contradiction.py` | Two-stage scope → retrieve → cooldown → adjudicate |
| `backend/app/panel.py` | The Deliberation Panel — two biased analysts, one referee |
| `backend/app/privacy.py` | Consent gate. "Off the record" stops ingestion entirely |
| `backend/app/authorization.py` | Nonce + TTL + argsHash gate. Voice authorizes nothing |
| `docs/echosphere_architecture_v6.md` | **The governing architecture** |
| `docs/session_log.md` | Cross-session memory: decisions, dead ends, corrections |

New here? Read `docs/session_log.md` first, then v6 §6 (epistemic discipline)
and §17 (why the Bridge was proven before anything depended on it).

---

## Rules that are not negotiable

1. **Echo never asserts causation.** Attribution is mandatory, causal language
   is interrogative only, and `INFERRED` claims never reach the voice channel.
   Tests fail the build if diagnosing language appears. *Restraint is the
   product — do not make Echo sound more confident.*
2. **All incident state flows through `incidentReducer`.** This is what makes
   determinism provable.
3. **Saturated colour is reserved for status.** If a button borrows red, red
   stops meaning "broken".
4. **Trust zones are enforced.** `src/lib/server/**` and `src/app/api/**` are
   Zone 2 and marked `server-only`. Client code may not import them, and a test
   fails if it does.
5. **Voice is an intent signal, never an authorization.** Approval is a
   nonce-bound token redeemed by a UI click from an authorized role.
6. **Don't trust a green build, and don't trust a green dependency.** Agora
   reports `RUNNING` whether or not a sound was made. Measure the audio.
7. **A prompt asking a model not to diagnose is a request, not a guarantee.**
   The panel's personas tried to assert causation six times in one afternoon.
   The tripwire that stops them is structural and lives in `panel.py`, not in
   any prompt. Do not weaken it to make an explanation read better.

---

## Validation

One command. It asserts against the **live** Agora API rather than our own
logging, because a green test suite is not a working product — four real UI
defects here once passed typecheck, lint and build.

```powershell
.\validate.ps1
```

28 checks in seven groups, then a single verdict:

1. **Test suites** — backend unit tests, typecheck, lint, frontend tests
2. **Services** — both up, credentials present, no degradation banner
3. **The tunnel** — routes, and the auth gate refuses unauthenticated,
   wrong-token and `/bridge/say` calls from outside
4. **A real Agora agent** — created, registered, tools enabled, `RUNNING`
   per Agora's own status endpoint
5. **Speech in, knowledge out** — claims extracted, the hedge kept out of the
   facts, **every claim attributed**
6. **The contradiction** — and whether the Deliberation Panel adjudicated it,
   on two different models
7. **What Agora actually voiced** — from its history: Echo spoke, greeted
   exactly once, produced no filler, and **never asserted a cause**

It also prints, on every pass, the one thing it *cannot* cover.

### The human-in-the-loop check

```powershell
cd frontend
npm run demo converse
```

Agora exposes **no way to inject a user turn** — probed against the live API:
`/agents/{id}/update` accepts `instruction`, `system_message` and
`user_message`, returns `200` for all three, and voices nothing; `/chat`,
`/message`, `/input_text` and a POST to `/history` are all `404`. A
conversational turn starts with real audio or it does not start.

So `converse` streams Agora's own transcript while you talk and names which of
four indistinguishable failures happened: nothing segmented, turns transcribed
empty, Echo refusing because it cannot read the Ledger, or Echo answering. It
discounts turns marked `start_type: "api_speak"` — Echo's own proactive lines
— so they cannot be mistaken for an answer.

---

## Demo requirements

**Two machines, two UIDs, headsets.** Per-UID separation is the whole
architecture; two presenters sharing one machine collapses it to one speaker.
Headsets prevent acoustic bleed between the streams.

---

## Known limitations

Stated plainly rather than discovered by a reviewer.

- **The Observer is an adapter, not real audio yet.** v6 §4.3 pulls one
  unmixed PCM stream per speaker via
  `on_playback_audio_frame_before_mixing`, which needs
  `agora-python-server-sdk` — and that has no wheel for Python 3.14. Transcripts
  currently arrive over RTM instead. Attribution is still per-speaker; what is
  missing is the structural guarantee. Fix: install Python 3.12, build a second
  venv, set `OBSERVER_MODE=agora`.
- **Groq's free tier is 200,000 tokens/day, scoped per model.** A full demo run
  costs 15–20k, so roughly ten rehearsals a day. A fallback chain keeps the
  pipeline alive when the primary model is exhausted, but the smaller models are
  measurably worse at adjudication.
- **The conversational turn is the one thing no script can verify.** Every
  stage either side of it is checked by `validate.ps1` against Agora's own
  records — agent lifecycle, ASR running, tools reachable, TTS speaking. The
  join between them needs a person at a microphone, because Agora has no
  text-injection endpoint (see Validation above). Budget a minute for
  `npm run demo converse` in every rehearsal.
- **Echo subscribes to exactly one UID.** `remote_rtc_uids` takes one
  participant — the schema says *"currently, only one user ID is supported"* —
  so Echo hears whoever joined first. Per-speaker audio for everyone else is
  the Observer work below.
- **The OPPOSED contradiction fires about two runs in three.** Adjudication is
  a model call under an 8000-tokens-per-**minute** ceiling. The epistemic
  separation underneath it — facts versus the hedge, all attributed — is
  deterministic and passes every run. If the contradiction does not fire
  before a demo, `npm run demo reset` and feed again.
- **The Roster is in-memory in Next.js.** Fine for a single dev server; it will
  not survive serverless, and the Python Roster is the intended home.
- **`frontend/public/listen.html` does not work on a fresh clone.** It loads the
  Agora SDKs from `public/vendor/`, which is gitignored — 3 MB of minified
  vendor JS does not belong in git history. It predates the console's own RTC
  join and is kept only as a debugging ear. To use it:

  ```bash
  cd frontend
  mkdir -p public/vendor
  cp node_modules/agora-rtc-sdk-ng/AgoraRTC_N-production.js public/vendor/
  cp node_modules/agora-rtm-sdk/agora-rtm.js public/vendor/
  ```

  You do not need it for the demo — the console joins the channel itself.
