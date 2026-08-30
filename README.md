# EchoSphere — Real-Time AI Incident Commander

**Echo** joins a live voice bridge during an outage, organises what people say
into a knowledge graph, separates confirmed facts from assumptions, surfaces
contradictions, tracks who owes what — and **never determines the root cause
itself.**

That last clause is not a limitation we apologise for. It is the product.

> Most AI incident tools will tell you the root cause. This one tells you what
> you actually know, who established it, and what nobody has checked.

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

Open **http://localhost:3000**, type a channel name, pick your role, and press
**Join incident bridge** (or `J`).

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
| `GROQ_API_KEY` | console.groq.com |
| `ELEVENLABS_API_KEY` | elevenlabs.io → API keys (starts `sk_`) |

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
cd frontend && npm run verify      # typecheck → lint → 95 tests → build
cd backend && .venv/Scripts/python -m unittest discover -s tests -t .   # 127 tests
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

---

## How it fits together

```
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
- **`frontend/public/listen.html` is throwaway.** It predates the console's own
  RTC join and should be deleted once nothing depends on it.
