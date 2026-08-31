"""
Does the Panel catch what the single judge missed?

Run:  .venv/Scripts/python -m rig.panel_check

The first pair is the one that silently failed a live rehearsal on Aug 30 —
correct entity, correct scope, correct retrieval, and the adjudicator still
returned INDEPENDENT. The last two pairs are the precision guard: a panel that
fires on those is worse than the judge it replaced.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from app.panel import deliberate


@dataclass
class C:
    text: str
    speaker_role: str
    entity: str = "redis"


CASES = [
    # (A, B, what a correct panel does, why it matters)
    (
        C("The cache is fine.", "DevOps Lead"),
        C("application logs are definitely showing cache read timeouts on the checkout path",
          "Support Engineer"),
        "OPPOSED",
        "THE REHEARSAL MISS — a health verdict against a contradicting measurement",
    ),
    (
        C("Memory is at 40 percent.", "DevOps Lead"),
        C("application logs are definitely showing cache read timeouts on the checkout path",
          "Support Engineer"),
        "QUIET",
        "unanimous INDEPENDENT is the DEFAULT for two claims on one entity — "
        "it must not interrupt (this cost a scripted demo beat, deliberately)",
    ),
    (
        C("Tickets are flooding in.", "Support Engineer", "checkout"),
        C("Latency is through the roof.", "DevOps Lead", "checkout"),
        "QUIET",
        "PRECISION GUARD — two symptoms of one fault must NOT interrupt",
    ),
    (
        C("Users say their carts empty the second they hit purchase.", "Support Engineer", "checkout"),
        C("massive spike in 500s on checkout", "DevOps Lead", "checkout"),
        "QUIET",
        "PRECISION GUARD — same failure from two angles",
    ),
    (
        C("Users say their carts empty the second they hit purchase.", "Support Engineer", "checkout"),
        C("Latency is through the roof.", "DevOps Lead", "checkout"),
        "QUIET",
        "THE PANEL'S OWN FALSE POSITIVE — unanimous INDEPENDENT@0.90 "
        "interrupted a live run on Aug 30",
    ),
]

G, R, Y, D = "\033[32m", "\033[31m", "\033[33m", "\033[2m"
X = "\033[0m"


async def main() -> None:
    passed = 0
    for a, b, want, note in CASES:
        v = await deliberate(a, b)

        # "QUIET" means: whatever it decided, it must not interrupt the room.
        ok = (not v.is_actionable) if want == "QUIET" else (
            v.relation == want and v.is_actionable
        )
        passed += ok

        print(f"\n{'─' * 74}")
        print(f"  A [{a.speaker_role}] {a.text}")
        print(f"  B [{b.speaker_role}] {b.text}")
        print(f"{D}  {note}{X}")
        print(f"  want {want:<12} got {v.relation}@{v.confidence:.2f} "
              f"actionable={v.is_actionable}  {G + '✓ PASS' + X if ok else R + '✗ FAIL' + X}")
        if v.dissent:
            print(f"{Y}  ── the panel SPLIT ──{X}")
        for p in v.positions:
            print(f"{D}    {p.persona:<9} {p.model:<26} {p.relation:<12}"
                  f"@{p.confidence:.2f}  {p.why[:60]}{X}")
        if v.why_other_failed:
            print(f"{Y}  referee — what the other analyst missed:{X} {v.why_other_failed}")

    print(f"\n{'═' * 74}")
    print(f"  {passed}/{len(CASES)} correct")


if __name__ == "__main__":
    asyncio.run(main())
