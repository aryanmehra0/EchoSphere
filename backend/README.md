# EchoSphere — Zone 3, the Slow Loop

The privileged process (v6 §10.1). Holds the analytical LLM key and, eventually,
Jira / Slack / PagerDuty. Next.js holds Agora credentials only; that split is
what makes the Blast Radius claim true by construction.

## Run

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt

.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
.venv/Scripts/python -m unittest discover -s tests -t .      # 13 tests
```

Credentials are read from `backend/.env`, falling back to
`frontend/.env.local` — so one filled-in file drives both processes.

```bash
curl 127.0.0.1:8000/health          # want ready:true
```

## What exists

| Module | Role | v6 |
|---|---|---|
| `models.py` | The data contract, mirroring `frontend/src/lib/types.ts` | §9.4 |
| `ledger.py` | Evidence Ledger — one claim table, four epistemic statuses | §6.1, §9.1 |
| `utterance.py` | **Composes Echo's exact words. Rules 1–2 enforced in code.** | §6.2 |
| `bridge.py` | Bridge Controller — `/speak`, `/interrupt`, INFERRED filter, 12s floor | §5 |
| `deltas.py` | Delta Hub — `seq`, HELLO / SNAPSHOT / REPLAY | §9.2, §9.3 |
| `main.py` | FastAPI surface: ingress, ledger, tool webhook, dashboard socket | §4 |

## The one deviation worth knowing about

v6 §5.1 drives Echo's proactive speech with **Custom Instruction Injection** —
the Slow Loop sends an instruction and the Fast Loop LLM decides what to say.
Measured on a live channel, that returns HTTP 200 and produces **no speech**.

Agora exposes `POST /agents/{id}/speak`, which drives the TTS module with a
literal string, and `POST /agents/{id}/interrupt`. Both verified live: 80–87%
peak audio, interrupt acknowledged in ~433 ms.

**This is an upgrade, not a workaround.** §6.2 concedes that Rules 1–2 are
"prompt-enforced and could be violated by a creative model". Now the Slow Loop
composes the literal sentence, so attribution and non-causal phrasing are
properties of `utterance.py` and its tests. A sentence that lacks a source, or
asserts causation in the indicative, **cannot be constructed** — `validate()`
raises before anything reaches the channel.

## The Observer is an adapter, on purpose

v6 §4.3 pulls per-UID PCM off the SD-RTN via
`on_playback_audio_frame_before_mixing`, which needs `agora-python-server-sdk`.
That package has **no wheel for Python 3.14** — the only interpreter on this
machine — and fails to build from source.

So the Observer is pluggable and `POST /observer/transcript` is its seam.
Anything that produces role-attributed text drives the identical downstream
pipeline, which also makes Rehearsal Rig Tier 2 (§15) trivial.

The agent-UID exclusion that closes **G2** lives at that seam: uid 9000/9001 is
dropped as the first branch, before anything is allocated.

To enable the real Observer: install Python 3.12, build a second venv, add
`agora-python-server-sdk`, and set `OBSERVER_MODE=agora`.

## Still to build

`extraction.py` (§14.2 · Groq), `contradiction.py` (§7 two-stage · closes G4),
`rti.py` (§8 normalized/EWMA/hysteresis · closes G5), `proxy.py` +
`authorization.py` (§4.5, §10.2 · closes G7), and the real Observer.
