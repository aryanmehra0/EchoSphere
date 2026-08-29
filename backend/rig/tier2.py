"""
Rehearsal Rig — Tier 2. v6 §15, closing G8.

Tier 1 (the frontend's node:test suite) drives the pure reducer with recorded
fixtures and catches state bugs in milliseconds. It cannot say anything about
extraction quality, because there is no model in it.

Tier 2 runs the REAL Slow Loop pipeline over fixed transcripts, N times, and
scores it. That converts the question "does the contradiction engine work?"
from an opinion formed by watching three demos into a number.

    .venv/Scripts/python -m rig.tier2 --runs 5
    .venv/Scripts/python -m rig.tier2 --runs 5 --scenario act2-contradiction

Why this had to exist before any more tuning: three consecutive rehearsals
produced the contradiction twice, and the obvious fix (temperature 0.0) made
it worse — 0 of 3. Both samples were n=3. Nothing can be tuned responsibly on
evidence that thin, and every hour spent guessing is an hour not spent on the
gate that actually blocks the demo.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time
from dataclasses import dataclass, field

from app.contradiction import ContradictionEngine
from app.extraction import compact, entity_aliases, extract
from app.ledger import Ledger
from app.models import Claim, Entity, Unchecked
from app.utterance import EpistemicViolation, contradiction_intervention, validate

from .fixtures import SCENARIOS, Scenario

C = {
    "ok": lambda s: f"\x1b[32m{s}\x1b[0m",
    "no": lambda s: f"\x1b[31m{s}\x1b[0m",
    "warn": lambda s: f"\x1b[33m{s}\x1b[0m",
    "hi": lambda s: f"\x1b[36m{s}\x1b[0m",
    "dim": lambda s: f"\x1b[2m{s}\x1b[0m",
}


@dataclass
class RunResult:
    claims: int = 0
    entities: int = 0
    hypotheses_correct: bool = True
    observed_correct: bool = True
    attribution_complete: bool = True
    contradiction_found: bool = False
    contradiction_expected: bool = False
    unchecked_found: bool = False
    entity_converged: bool | None = None
    wrong_pair: bool = False
    utterance_valid: bool | None = None
    seconds: float = 0.0
    notes: list[str] = field(default_factory=list)

    @property
    def correct(self) -> bool:
        """Everything the scenario asked for, and nothing it forbade."""
        return (
            self.hypotheses_correct
            and self.observed_correct
            and self.attribution_complete
            and self.contradiction_found == self.contradiction_expected
            and not self.wrong_pair
            and self.utterance_valid is not False
        )


async def run_once(scenario: Scenario) -> RunResult:
    """One full pass of the real pipeline over the fixture."""
    started = time.perf_counter()
    result = RunResult(contradiction_expected=bool(scenario.expect_contradiction_between))

    ledger = Ledger()
    engine = ContradictionEngine()

    # Feed the dialogue one line at a time, as the Observer would.
    for line in scenario.lines:
        window = f"[{line.role}] {line.text}"
        extracted = await extract(window, compact(ledger), aliases=entity_aliases(ledger))

        for row in extracted["entities"]:
            try:
                ledger.upsert_entity(Entity(
                    id=str(row["id"]), label=str(row.get("label", row["id"])),
                    aliases=[str(a) for a in (row.get("aliases") or [])],
                    kind=row.get("kind", "service"), status=row.get("status", "UNKNOWN"),
                ))
            except (KeyError, TypeError, ValueError):
                continue

        for row in extracted["unchecked"]:
            try:
                ledger.upsert_unchecked(Unchecked(
                    id=str(row["id"]), description=str(row["description"]),
                    suggested_owner=row.get("suggestedOwner"),
                ))
            except (KeyError, TypeError, ValueError):
                continue

        for row in extracted["claims"]:
            try:
                claim = Claim(
                    id=str(row["id"]), text=str(row["text"]), entity=row.get("entity"),
                    epistemic_status=row["epistemicStatus"],
                    speaker_role=row["speakerRole"],
                    confidence=float(row.get("confidence", 0.8)),
                )
            except (KeyError, TypeError, ValueError) as exc:
                result.attribution_complete = False
                result.notes.append(f"unusable claim: {exc}")
                continue

            existing = list(ledger.claims.values())
            ledger.upsert_claim(claim)

            found = await engine.evaluate(claim, existing)
            if found and not result.contradiction_found:
                other, verdict = found
                result.contradiction_found = True

                # A detected conflict must also be SAYABLE. If composition
                # raises, the engine found something Echo cannot voice, which
                # is a failure even though detection worked.
                try:
                    line_text = contradiction_intervention(
                        claim, other, relation=verdict.relation,
                        gap=next(iter(ledger.open_unchecked()), None),
                    )
                    validate(line_text)
                    result.utterance_valid = True
                except EpistemicViolation as exc:
                    result.utterance_valid = False
                    result.notes.append(f"unsayable: {exc}")

                if scenario.expect_contradiction_between:
                    pair = f"{claim.text} {other.text}".lower()
                    ok = any(
                        a.lower() in pair and b.lower() in pair
                        for a, b in scenario.expect_contradiction_between
                    )
                    if not ok:
                        result.wrong_pair = True
                        result.notes.append(
                            f"fired on an unexpected pair: {claim.text!r} vs {other.text!r}"
                        )

    result.claims = len(ledger.claims)
    result.entities = len(ledger.entities)
    result.unchecked_found = bool(ledger.unchecked)

    # -- score the epistemic tagging ---------------------------------------
    all_claims = list(ledger.claims.values())

    for needle in scenario.expect_hypotheses:
        matches = [c for c in all_claims if needle.lower() in c.text.lower()]
        if not matches:
            result.hypotheses_correct = False
            result.notes.append(f"no claim mentions {needle!r} at all")
        elif not any(c.epistemic_status == "HYPOTHESIS" for c in matches):
            result.hypotheses_correct = False
            got = {c.epistemic_status for c in matches}
            result.notes.append(f"{needle!r} tagged {got} — should be HYPOTHESIS")

    for needle in scenario.expect_observed:
        matches = [c for c in all_claims if needle.lower() in c.text.lower()]
        if matches and not any(
            c.epistemic_status in ("OBSERVED", "TOOL_RESULT") for c in matches
        ):
            result.observed_correct = False
            result.notes.append(f"{needle!r} was not recorded as established")

    if any(not c.speaker_role.strip() for c in all_claims):
        result.attribution_complete = False

    # -- did the two conflicting claims end up on ONE entity? --------------
    for a, b in scenario.expect_contradiction_between:
        ca = next((c for c in all_claims if a.lower() in c.text.lower()), None)
        cb = next((c for c in all_claims if b.lower() in c.text.lower()), None)
        if not (ca and cb):
            continue
        converged = bool(ca.entity) and ca.entity == cb.entity
        # ANY acceptable pair converging is enough.
        result.entity_converged = converged or bool(result.entity_converged)
        if not converged:
            result.notes.append(
                f"entity split: {a!r}->{ca.entity!r} vs {b!r}->{cb.entity!r}"
            )

    result.seconds = time.perf_counter() - started
    return result


# Groq's free tier is 8000 tokens/minute. Back-to-back runs exhaust it and the
# scorecard then measures the rate limiter rather than the pipeline — four runs
# once reported 0% across the board purely because every one of them crashed.
PACE_SECONDS = 20.0


async def measure(scenario: Scenario, runs: int) -> list[RunResult]:
    results: list[RunResult] = []
    for i in range(runs):
        if i:
            await asyncio.sleep(PACE_SECONDS)
        print(f"  run {i + 1}/{runs} … ", end="", flush=True)
        try:
            r = await run_once(scenario)
        except Exception as exc:  # noqa: BLE001 — a crashed run is a data point
            r = RunResult()
            r.attribution_complete = False
            r.notes.append(f"run raised: {exc}")
        results.append(r)
        print(
            f"{C['ok']('ok') if r.correct else C['no']('FAIL')}  "
            f"{r.seconds:.1f}s  claims={r.claims}"
        )
        for note in r.notes:
            print(f"        {C['dim'](note)}")
    return results


def report(scenario: Scenario, results: list[RunResult]) -> bool:
    n = len(results)
    if not n:
        return False

    def rate(pred) -> float:
        return sum(1 for r in results if pred(r)) / n

    print(f"\n  {C['hi']('SCORECARD')}  {scenario.name}   n={n}\n")

    rows: list[tuple[str, float, str]] = [
        ("epistemic tagging correct", rate(lambda r: r.hypotheses_correct and r.observed_correct),
         "fact vs assumption — the brief's central demand"),
        ("every claim attributed", rate(lambda r: r.attribution_complete),
         "§6.2 Rule 1"),
    ]

    if scenario.expect_contradiction_between:
        rows.append(("contradiction detected", rate(lambda r: r.contradiction_found),
                     "the headline feature"))
        converged = [r for r in results if r.entity_converged is not None]
        if converged:
            rows.append(("entity ids converged",
                         sum(1 for r in converged if r.entity_converged) / len(converged),
                         "the precondition detection depends on"))
        voiced = [r for r in results if r.utterance_valid is not None]
        if voiced:
            rows.append(("intervention was sayable",
                         sum(1 for r in voiced if r.utterance_valid) / len(voiced),
                         "§6 composition survived"))
    else:
        rows.append(("stayed silent (correctly)", rate(lambda r: not r.contradiction_found),
                     "precision — a false alarm gets Echo muted"))

    if scenario.expect_unchecked:
        rows.append(("noticed a gap", rate(lambda r: r.unchecked_found), "requirement 5"))

    for label, value, why in rows:
        pct = f"{value * 100:.0f}%"
        colour = C["ok"] if value >= 0.95 else C["warn"] if value >= 0.7 else C["no"]
        print(f"    {label:<28} {colour(pct.rjust(4))}   {C['dim'](why)}")

    times = [r.seconds for r in results]
    print(f"\n    {'median run time':<28} {statistics.median(times):.1f}s")

    overall = rate(lambda r: r.correct)
    print(f"\n    {'FULLY CORRECT RUNS':<28} "
          f"{(C['ok'] if overall >= 0.95 else C['no'])(f'{overall * 100:.0f}%')}"
          f"   {sum(1 for r in results if r.correct)}/{n}")

    # §17's S6 gate is three clean runs in a row. A rate below 95% cannot be
    # trusted to deliver that on stage.
    passed = overall >= 0.95
    print(f"\n  {C['ok']('GATE MET') if passed else C['no']('GATE NOT MET')}"
          f"  {C['dim']('(needs >=95% for S6 three-clean-runs)')}\n")
    return passed


def main() -> int:
    ap = argparse.ArgumentParser(description="Rehearsal Rig Tier 2")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--scenario", default="full-demo", choices=sorted(SCENARIOS))
    ap.add_argument("--all", action="store_true", help="every scenario")
    args = ap.parse_args()

    targets = list(SCENARIOS.values()) if args.all else [SCENARIOS[args.scenario]]

    print(f"\n  {C['hi']('REHEARSAL RIG — TIER 2')}   real pipeline, real model\n")

    all_passed = True
    for scenario in targets:
        print(f"  {C['hi'](scenario.name)}")
        results = asyncio.run(measure(scenario, args.runs))
        all_passed &= report(scenario, results)

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
