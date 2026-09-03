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

## Quick start

Three processes. Two terminals plus a browser.

```bash
# 1 — Slow Loop (Python, Zone 3)
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt          # Windows
# .venv/bin/pip install -r requirements.txt            # macOS / Linux
.venv/Scripts/python -m uvicorn app.main:app --port 8000

# 2 — Console + Zone 2 API (Next.js)
cd frontend
npm install
cp .env.local.example .env.local     # then fill it in — see Credentials
npm run dev                          # http://localhost:3000
```

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

```bash
cd frontend && npm run verify      # typecheck → lint → 106 tests → build
cd backend && .venv/Scripts/python -m unittest discover -s tests -t .   # 172 tests
```

**No slot is done until `npm run verify` passes.** And a green build says
nothing about whether the UI works — screenshot the running app.

### Measuring quality, not just correctness

```bash
cd backend
.venv/Scripts/python -m rig.tier2 --runs 5 --scenario full-demo
```

The Rehearsal Rig runs the real pipeline over fixed transcripts N times and
**scores** it: contradiction detection, precision, epistemic tagging,
attribution, entity convergence. It exists because reliability cannot be tuned
by watching three demos — every fix in the contradiction engine was chosen by
this number moving.

**Tier 3** goes further and drives the running server the way the demo does —
real endpoints, real Ledger, real deltas, at conversational pace:

```bash
.venv/Scripts/python -m rig.tier3 --runs 3    # needs the Slow Loop running
```

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
