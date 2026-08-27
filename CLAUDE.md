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

- **Phase 1** (console UI) — done, v6-aligned
- **S1** (identity layer: tokens, Roster, agent lifecycle) — code done, never run live
- **S0** (Bridge Spike) — script ready, **not yet run**
- **Blocker:** `frontend/.env.local` is empty. Check with
  `curl localhost:3000/api/health` → want `ready: true`.

---

## Commands

```bash
cd frontend
npm run verify    # typecheck → lint → tests → build   ← the gate
npm run test      # Rehearsal Rig Tier 1
npm run dev       # localhost:3000
npm run spike     # S0 Bridge Spike (needs credentials)
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

---

## Working agreement

- Update `docs/session_log.md` at the end of any session that makes a decision,
  hits a dead end, or discovers something the code doesn't say. **Record
  corrections too** — it is only useful if it stays honest.
- Commit and push only when asked.
- `.env.local` holds real secrets and is gitignored. Never read it to check
  status; use `/api/health`, which reports presence without values.
