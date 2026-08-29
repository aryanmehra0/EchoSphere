"""
Rehearsal Rig fixtures — v6 §15.

Every acceptance test in v5 §10.3 required three humans with three microphones
talking on cue. That is not a test suite, it is a rehearsal: it cannot run in
CI, cannot run at 2am the night before submission, and cannot isolate a
regression to a component.

These fixtures are the replacement. They are the Demo Script v2 dialogue
(§18) with the outcomes we care about declared alongside, so a run can be
SCORED rather than eyeballed.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Line:
    role: str
    uid: int
    text: str


@dataclass(frozen=True)
class Scenario:
    name: str
    lines: list[Line]

    # -- what a correct run must produce ------------------------------------

    expect_hypotheses: list[str] = field(default_factory=list)
    """Substrings that MUST be tagged HYPOTHESIS, not OBSERVED. The
    fact-versus-assumption split is the brief's central demand, so getting
    'might be evicting keys' filed as a fact is a correctness failure."""

    expect_observed: list[str] = field(default_factory=list)
    """Substrings that must be tagged OBSERVED — a measurement recorded as a
    guess is just as wrong in the other direction."""

    expect_contradiction_between: list[tuple[str, str]] = field(default_factory=list)
    """Acceptable conflicting pairs, as substring pairs. ANY of them counts.

    Deliberately a list, not one pair. The first version demanded exactly
    ('40 percent', 'timeout') and scored the engine WRONG when it fired on
    'the cache is fine' vs 'cache read timeouts' — which is a sharper conflict
    than the one I had written down, and plainly a correct detection. A
    fixture that punishes a better answer measures the fixture, not the
    system."""

    expect_unchecked: bool = False
    """Requirement 5's quiet half: the run should notice something nobody
    established."""


# ---------------------------------------------------------------------------
# The demo dialogue, split into the beats it is scored on
# ---------------------------------------------------------------------------

ACT1_CHAOS = Scenario(
    name="act1-chaos",
    lines=[
        Line("DevOps Lead", 1001,
             "Everyone on the bridge, massive spike in 500s on checkout. "
             "Latency is through the roof. Datadog looks like Redis might be evicting keys."),
        Line("Support Engineer", 1002,
             "Tickets are flooding in. Users say their carts empty the second they hit purchase."),
    ],
    # "might be evicting" is a PROPOSED CAUSE. Nobody has measured the cache.
    # This is the distinction the demo stops to point at, and the one most
    # entries silently collapse into "facts".
    expect_hypotheses=["evict"],
    expect_observed=["500", "checkout"],
    expect_unchecked=True,
)

ACT2_CONTRADICTION = Scenario(
    name="act2-contradiction",
    lines=[
        Line("DevOps Lead", 1001,
             "Wait. I checked the primary Redis shard directly. "
             "Memory is at 40 percent. The cache is fine."),
        Line("Support Engineer", 1002,
             "But application logs are definitely showing cache read timeouts on the checkout path."),
    ],
    expect_observed=["40 percent", "timeout"],
    expect_contradiction_between=[
        ("40 percent", "timeout"),
        # "the cache is fine" vs "cache read timeouts" is the sharper conflict
        # and the engine finds it more often. Scoring that as WRONG measured
        # the fixture, not the system.
        ("cache is fine", "timeout"),
    ],
)

FULL_DEMO = Scenario(
    name="full-demo",
    lines=[*ACT1_CHAOS.lines, *ACT2_CONTRADICTION.lines],
    expect_hypotheses=["evict"],
    expect_observed=["500", "40 percent", "timeout"],
    expect_contradiction_between=[
        ("40 percent", "timeout"),
        ("cache is fine", "timeout"),
    ],
    expect_unchecked=True,
)

# A scenario with NO conflict in it. Precision matters as much as recall: an
# engine that fires on this would interrupt a calm bridge constantly, which is
# the G4 failure mode that makes Echo get muted.
NO_CONFLICT = Scenario(
    name="no-conflict",
    lines=[
        Line("DevOps Lead", 1001, "Redis memory is at 40 percent, well under the eviction threshold."),
        Line("Support Engineer", 1002, "Confirmed, the cache metrics look healthy from our side too."),
    ],
    expect_observed=["40 percent"],
)

# G4 row 4: same wording, different entity. Must NEVER be adjudicated.
DIFFERENT_ENTITIES = Scenario(
    name="different-entities",
    lines=[
        Line("DevOps Lead", 1001, "Redis memory is at 40 percent."),
        Line("Database Admin", 1003, "Postgres memory is at 95 percent."),
    ],
    expect_observed=["40 percent", "95 percent"],
)

SCENARIOS = {
    s.name: s for s in (ACT1_CHAOS, ACT2_CONTRADICTION, FULL_DEMO, NO_CONFLICT, DIFFERENT_ENTITIES)
}
