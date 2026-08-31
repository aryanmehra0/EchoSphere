# EchoSphere — Real-Time AI Incident Commander

An AI ("Echo") that joins a live voice bridge during an outage, organises what
people say into a knowledge graph, separates confirmed facts from assumptions,
and surfaces contradictions — **without ever determining the root cause
itself.** That final constraint is the grading rubric, not a nicety.

Hackathon: EchoSphere / Agora Conversational AI. Finale Sep 12, 2026.

---

## 📖 Read these before doing anything

| Order | File | Why |
|---|---|---|
| 1 | `docs/session_log.md` | **Cross-session memory.** Current status, the active blocker, decisions and their reasons, corrections, what NOT to do. |
| 2 | `docs/echosphere_architecture_v6.md` | The governing architecture. §6 (epistemic discipline) and §17 (risk-ordered plan) matter most. |
| 3 | `docs/handoff_log.md` | Structure, layout, gotchas, how to run. |
| 4 | `frontend/src/app/globals.css` | The design system, heavily commented. Read before writing any UI. |

`docs/echosphere_master_context.md` is **v5 — superseded.** Kept only as the
record of what v6's analysis was performed against. Do not follow it.

---

## Current state

**No blockers.** All credentials are in; `/api/health` and `/health` both
report `ready: true`. The pipeline runs end to end and is screenshotted.

- **Phase 1** (console UI) — done, v6-aligned, 0 console errors
- **S3 / S4 / S5** — done and verified live (speech → graph → contradiction →
  authorization gate). The Authorization Gate was proven the hard way: a
  verbal "yes" does not authorize, a wrong role is rejected, a replay is rejected.
- **S6** — **gate MET Aug 31**: three consecutive clean Tier 3 runs, 10/10 each
- **§7a Deliberation Panel** (Aug 31) — replaced the single adjudicator. Two
  oppositely-biased analysts on different models, a referee for splits.
- **§10.5 Consent gate** (Aug 31) — "off the record" stops ingestion entirely
- **S1** (identity) — code done and tested, but **never run on two machines**
- **S2** (Observer) — adapter seam only. Agent-UID exclusion (G2) is live;
  real per-UID PCM is blocked on `agora-python-server-sdk` having no Python
  3.14 wheel. Transcripts arrive over RTM instead.
- **Fast Loop is CASCADED, not audio-to-audio.** No OpenAI key was obtainable,
  so it is Agora ASR → **Groq** (`openai/gpt-oss-120b`) → TTS vendor. §12.1's
  latency budget therefore does not apply.
- ⚠️ **Agora does not validate `tts.params`.** A wrong param name still returns
  `200 RUNNING`, and Echo then joins and never speaks, with no error anywhere.
  ElevenLabs reads `key`; Sarvam reads `api_subscription_key`. If Echo is
  silent, suspect that first.

---

## Commands

```bash
cd frontend
npm run verify    # typecheck → lint → tests → build   ← the gate
npm run test      # Rehearsal Rig Tier 1
npm run dev       # localhost:3000
npm run spike     # S0 Bridge Spike (needs credentials)
```

```bash
cd backend
.venv/Scripts/python -m unittest discover -s tests -t .   # 155 tests
.venv/Scripts/python -m uvicorn app.main:app --port 8000  # the Slow Loop
.venv/Scripts/python -m rig.tier2 --runs 5 --scenario full-demo
.venv/Scripts/python -m rig.tier3 --runs 3   # ← the S6 gate, needs the server up
```

**No slot is "done" until `npm run verify` passes.**

---

## Rules that are not negotiable

1. **Echo never asserts causation.** Attribution is mandatory, causal language
   is interrogative only, and `INFERRED` claims never reach the voice channel.
   Tests fail the build if diagnosing language appears in Echo's dialogue.
   *Restraint is the product — do not make Echo sound more confident.*
2. **All incident state flows through `incidentReducer`.** No component holds
   its own copy. This is what makes determinism provable.
3. **Saturated colour is reserved for status.** Never for decoration.
4. **Trust zones are enforced.** `src/lib/server/**` and `src/app/api/**` are
   Zone 2 (Agora credentials, `server-only`). Client code may not import them.
   Zone 3 keys (Jira/Slack/PagerDuty) never appear in this repo.
5. **Run S0 before building anything that depends on the Bridge.** v6 §17
   reordered the entire plan for this reason.
6. **Don't trust a green build.** Screenshot the running app — four real UI
   defects once passed typecheck, lint and build.
7. **Don't trust your own harness either.** A DOM-scraping check here reported
   "contradiction surfaced ✓" because its regex matched the word `CONFLICTS`
   in the page header, and another passed an interrupt check against an
   all-zero audio trace. Assert against the API (`rig/tier3.py`), and read the
   screenshot yourself.
8. **A prompt asking a model not to diagnose is a request, not a guarantee.**
   The Panel's personas asserted causation six times in one afternoon. The
   tripwire that stops them is structural — a causal connector in the same
   sentence as telemetry vocabulary — and lives in `panel.py`. Never weaken it
   to make an explanation read better.

---

## Working agreement

- Update `docs/session_log.md` at the end of any session that makes a decision,
  hits a dead end, or discovers something the code doesn't say. **Record
  corrections too** — it is only useful if it stays honest.
- Commit and push only when asked.
- `.env.local` holds real secrets and is gitignored. Never read it to check
  status; use `/api/health`, which reports presence without values.
