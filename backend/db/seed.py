"""
Seed a realistic incident so Echo has something to answer questions ABOUT.

    backend/.venv/Scripts/python -m db.seed          # from backend/
    backend/.venv/Scripts/python -m db.seed --clear  # wipe instead

────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

Echo answers factual questions by calling `query_incident_state`, which is a
deterministic read of the Ledger — no LLM in the path. That is what makes
"ask eight times, get eight identical answers" structural rather than a hope
about model stability.

The corollary is that an EMPTY Ledger makes Echo look broken. Ask it anything
and it correctly answers "that hasn't been established by anyone on this
bridge", which is indistinguishable, from the room, from an agent that cannot
hear you. Testing the conversation therefore needs a populated record, and
populating one by talking for ten minutes before every test is not a test
loop anyone will actually run.

────────────────────────────────────────────────────────────────────────────
WHAT IS SEEDED, AND WHY IT IS SHAPED THIS WAY

Every branch of `Ledger.query` gets rows, because each is a different question
someone will ask out loud:

    summary        "Echo, what do we know so far?"
    entity         "Echo, what do we know about Redis?"
    unresolved     "Echo, what is still open?"
    contradictions "Echo, is anything conflicting?"
    open_tasks     "Echo, who is doing what?"

The claims deliberately include a CONTRADICTION — DevOps measured Redis memory
at 40% while Support reports cache read timeouts — because the product's whole
argument is what it does with conflicting evidence, and a seed without one
exercises none of it.

Epistemic statuses are chosen against the real projections:
  OBSERVED   -> `established()`, so Echo may state it aloud with attribution
  HYPOTHESIS -> `hypotheses()`, so it shows as unconfirmed
  INFERRED   -> excluded from `recap()` and never spoken (§6.2 Rule 3)
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# Runnable as `python db/seed.py` as well as `python -m db.seed`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import store  # noqa: E402
from app.models import (  # noqa: E402
    Claim,
    Contradiction,
    Entity,
    Link,
    Task,
    TimelineEvent,
    Transcript,
    Unchecked,
    now_ms,
)

CHANNEL = "inc-4417"

# Relative offsets so the timeline reads in order however long ago this runs.
T0 = now_ms() - 14 * 60_000


def _at(minutes: float) -> int:
    return int(T0 + minutes * 60_000)


ENTITIES = [
    Entity(id="redis", label="Redis", kind="service", status="WARNING",
           detail="Primary cache cluster", metric="memory 40%",
           aliases=["cache", "redis-primary", "the cache"],
           position={"x": 0.30, "y": 0.35}),
    Entity(id="checkout", label="Checkout", kind="service", status="CRITICAL",
           detail="Customer-facing checkout API", metric="5xx 12%",
           aliases=["checkout api", "payments"],
           position={"x": 0.62, "y": 0.30}),
    Entity(id="postgres", label="Postgres", kind="datastore", status="WARNING",
           detail="Orders database, primary + one replica",
           metric="replica lag 8s",
           aliases=["db", "the database", "orders db"],
           position={"x": 0.46, "y": 0.66}),
]

LINKS = [
    Link(id="l-checkout-redis", source="checkout", target="redis",
         label="reads session state", kind="depends"),
    Link(id="l-checkout-pg", source="checkout", target="postgres",
         label="writes orders", kind="depends"),
]

CLAIMS = [
    # OBSERVED — measured. Echo may say these aloud, attributed.
    Claim(id="c-001", text="checkout 5xx rate jumped from 0.2 percent to 12 percent at 14:02",
          epistemic_status="OBSERVED", speaker_role="DevOps Lead",
          confidence=0.95, at=_at(0), entity="checkout"),
    Claim(id="c-002", text="Redis primary memory is at 40 percent, well under the eviction threshold",
          epistemic_status="OBSERVED", speaker_role="DevOps Lead",
          confidence=0.9, at=_at(2), entity="redis"),
    Claim(id="c-003", text="Postgres replica lag is 8 seconds and climbing",
          epistemic_status="OBSERVED", speaker_role="Database Admin",
          confidence=0.9, at=_at(6), entity="postgres"),
    Claim(id="c-004", text="the orders table has a lock wait averaging 4 seconds",
          epistemic_status="OBSERVED", speaker_role="Database Admin",
          confidence=0.85, at=_at(9), entity="postgres"),

    # HYPOTHESIS — said, not measured. These are the open questions.
    Claim(id="c-005", text="customers are seeing carts empty at the payment step",
          epistemic_status="HYPOTHESIS", speaker_role="Support Engineer",
          confidence=0.7, at=_at(1), entity="checkout"),
    Claim(id="c-006", text="application logs show cache read timeouts against Redis",
          epistemic_status="HYPOTHESIS", speaker_role="Support Engineer",
          confidence=0.65, at=_at(4), entity="redis",
          # The other half of the contradiction below.
          contradicts=["c-002"]),
    Claim(id="c-007", text="the checkout deploy at 13:55 may be related",
          epistemic_status="HYPOTHESIS", speaker_role="DevOps Lead",
          confidence=0.5, at=_at(11), entity="checkout"),

    # INFERRED — the model's own guess. Never spoken, never in the recap.
    Claim(id="c-008", text="cache pressure is the likely root cause",
          epistemic_status="INFERRED", speaker_role="Echo",
          confidence=0.4, at=_at(12), entity="redis"),
]

CONTRADICTIONS = [
    Contradiction(
        id="x-001", claim_a="c-002", claim_b="c-006",
        speakers=["DevOps Lead", "Support Engineer"], at=_at(5),
        resolved=False, relation="measurement_vs_symptom",
        why=("DevOps measured Redis memory at 40 percent, which is healthy, "
             "while Support reports cache read timeouts against the same "
             "service. Both cannot describe the same Redis unless the "
             "timeouts have a cause other than memory pressure."),
        panel={"votes": {"conflict": 2, "no_conflict": 1}, "verdict": "conflict"},
    ),
]

UNCHECKED = [
    Unchecked(id="u-001", description="nobody has checked Redis connection pool saturation",
              at=_at(5), suggested_owner="DevOps Lead"),
    Unchecked(id="u-002", description="the 13:55 checkout deploy has not been diffed",
              at=_at(11), suggested_owner="DevOps Lead"),
    Unchecked(id="u-003", description="no one has confirmed whether the replica lag predates the 5xx spike",
              at=_at(7), suggested_owner="Database Admin"),
]

TASKS = [
    Task(id="t-001", assignee_role="DevOps Lead",
         description="Pull Redis connection pool metrics for 13:50 to 14:10",
         status="OPEN", at=_at(6), evidence=["c-002", "c-006"]),
    Task(id="t-002", assignee_role="Database Admin",
         description="Report whether replica lag started before or after 14:02",
         status="OPEN", at=_at(8), evidence=["c-003"]),
    Task(id="t-003", assignee_role="Support Engineer",
         description="Collect three affected order IDs with timestamps",
         status="DONE", at=_at(3), evidence=["c-005"]),
]

TIMELINE = [
    TimelineEvent(id="tl-001", kind="decision", text="Sev-1 declared, bridge opened",
                  actor="DevOps Lead", at=_at(0)),
    TimelineEvent(id="tl-002", kind="observation", text="Support joined and reported customer impact",
                  actor="Support Engineer", at=_at(1)),
    TimelineEvent(id="tl-003", kind="observation", text="DBA joined and began checking replication",
                  actor="Database Admin", at=_at(6)),
    TimelineEvent(id="tl-004", kind="decision", text="Conflicting evidence on Redis flagged for adjudication",
                  actor="Echo", at=_at(5)),
]

# The raw record beneath the claims — what was actually said.
TRANSCRIPTS = [
    Transcript(message_id="s-001", uid=1001, role="DevOps Lead",
               text="Everyone on the bridge, we have a massive spike in 500s on checkout starting 14:02.",
               is_final=True, at=_at(0)),
    Transcript(message_id="s-002", uid=1002, role="Support Engineer",
               text="Tickets are flooding in. Users say their carts empty at the payment step.",
               is_final=True, at=_at(1)),
    Transcript(message_id="s-003", uid=1001, role="DevOps Lead",
               text="I checked the primary Redis shard directly. Memory is at 40 percent. The cache is fine.",
               is_final=True, at=_at(2)),
    Transcript(message_id="s-004", uid=1002, role="Support Engineer",
               text="But application logs are definitely showing cache read timeouts.",
               is_final=True, at=_at(4)),
    Transcript(message_id="s-005", uid=1003, role="Database Admin",
               text="Replica lag is eight seconds and climbing. Lock waits on the orders table are around four seconds.",
               is_final=True, at=_at(6)),
]


async def seed() -> None:
    if not await store.connect():
        print("  Postgres is not reachable — nothing seeded.")
        print("  Start it with:  docker compose up -d")
        return

    await store.clear(CHANNEL)

    groups = [
        ("entities", ENTITIES), ("links", LINKS), ("claims", CLAIMS),
        ("contradictions", CONTRADICTIONS), ("unchecked", UNCHECKED),
        ("tasks", TASKS), ("timeline", TIMELINE), ("transcripts", TRANSCRIPTS),
    ]
    for _, rows in groups:
        store.save_many(rows, CHANNEL)

    # Writes are fire-and-forget by design; a seed has to wait for them.
    await asyncio.gather(*list(store._tasks))  # noqa: SLF001 — same-package seam

    for name, rows in groups:
        print(f"  {name:16} {len(rows)}")

    print()
    print("  Seeded. RESTART THE BACKEND so it restores this into memory —")
    print("  the Ledger is read from RAM, and only reads Postgres at startup.")
    await store.close()


async def clear() -> None:
    if not await store.connect():
        print("  Postgres is not reachable — nothing to clear.")
        return
    await store.clear(CHANNEL)
    print(f"  cleared {CHANNEL}")
    await store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed a demo incident.")
    parser.add_argument("--clear", action="store_true", help="wipe instead of seeding")
    args = parser.parse_args()
    asyncio.run(clear() if args.clear else seed())
