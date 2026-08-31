"""
The Contradiction Engine — v6 §7, closing G4.

The four rows from §2/G4's table are asserted directly, because they are the
exact failure modes a single-threshold implementation gets wrong.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from app.contradiction import (
    ADJUDICATION_CONFIDENCE_GATE,
    Adjudication,
    ContradictionEngine,
)
from app.models import Claim, now_ms


def claim(cid: str, text: str, entity: str, role="DevOps Lead", status="OBSERVED", at=None) -> Claim:
    return Claim(id=cid, text=text, entity=entity, epistemic_status=status,
                 speaker_role=role, confidence=0.95, at=at if at is not None else now_ms())


def verdict(relation: str, confidence: float):
    async def fake(system, user):
        return json.dumps({"relation": relation, "confidence": confidence, "why": "test"})
    return fake


def run(coro):
    return asyncio.run(coro)


class TestStage0Scope(unittest.TestCase):
    """Scoping is what makes the row-4 false positive IMPOSSIBLE, not unlikely."""

    def setUp(self):
        self.eng = ContradictionEngine()

    def test_claims_about_a_different_entity_are_never_compared(self):
        # G4 row 4: "Redis memory 40%" vs "Postgres memory 40%" scores ~0.94 on
        # a cosine model and is NOT a contradiction.
        new = claim("c1", "Redis memory is at 40 percent", "redis")
        other = claim("c2", "Postgres memory is at 40 percent", "postgres")
        self.assertEqual(self.eng.scope(new, [other]), [])

    def test_a_claim_with_no_entity_yields_no_candidates(self):
        new = claim("c1", "something vague", entity=None)  # type: ignore[arg-type]
        new.entity = None
        self.assertEqual(self.eng.scope(new, [claim("c2", "x", "redis")]), [])

    def test_claims_outside_the_30_minute_window_are_dropped(self):
        now = now_ms()
        old = claim("c2", "Redis memory is at 40 percent", "redis", at=now - 31 * 60 * 1000)
        new = claim("c1", "Redis memory is at 95 percent", "redis", at=now)
        self.assertEqual(self.eng.scope(new, [old], now_ms_=now), [])

    def test_hypotheses_and_inferences_are_not_conflict_candidates(self):
        new = claim("c1", "Redis memory is at 40 percent", "redis")
        hyp = claim("c2", "Redis might be evicting keys", "redis", status="HYPOTHESIS")
        inf = claim("c3", "packet loss would isolate the cache", "redis", status="INFERRED")
        self.assertEqual(self.eng.scope(new, [hyp, inf]), [])

    def test_one_speakers_consecutive_statements_are_NOT_a_conflict(self):
        # Found live. "I checked the shard. Memory is at 40 percent. It is not
        # eviction, the cache is fine." extracts as three claims, and without
        # this filter the engine adjudicated DevOps against DevOps twice —
        # two spurious interruptions before the real conflict was reached.
        now = now_ms()
        a = claim("c1", "Memory is at 40 percent", "redis", at=now)
        b = claim("c2", "The cache is fine", "redis", at=now + 300)
        self.assertEqual(self.eng.scope(a, [b], now_ms_=now), [])

    def test_the_same_speaker_correcting_themselves_LATER_still_counts(self):
        # Deliberately time-boxed rather than a blanket same-speaker ban: an
        # engineer revising a measurement ten minutes on is worth surfacing.
        now = now_ms()
        old = claim("c1", "Memory is at 40 percent", "redis", at=now - 10 * 60 * 1000)
        new = claim("c2", "Memory is at 95 percent", "redis", at=now)
        self.assertEqual([c.id for c in self.eng.scope(new, [old], now_ms_=now)], ["c1"])

    def test_two_different_speakers_are_always_candidates(self):
        now = now_ms()
        a = claim("c1", "The cache is fine", "redis", role="DevOps Lead", at=now)
        b = claim("c2", "cache read timeouts observed", "redis",
                  role="Support Engineer", at=now + 300)
        self.assertEqual([c.id for c in self.eng.scope(a, [b], now_ms_=now)], ["c2"])

    def test_a_same_entity_observation_IS_a_candidate(self):
        # Two DIFFERENT speakers. This test originally used the same role for
        # both and passed only because the same-utterance filter did not exist
        # yet; it was asserting less than it appeared to.
        new = claim("c1", "Redis memory is at 40 percent", "redis", role="DevOps Lead")
        other = claim("c2", "Redis cache read timeouts observed", "redis",
                      role="Support Engineer")
        self.assertEqual([c.id for c in self.eng.scope(new, [other])], ["c2"])


class TestStage1Retrieve(unittest.TestCase):

    def setUp(self):
        self.eng = ContradictionEngine()

    def test_related_claims_are_retrieved(self):
        new = claim("c1", "Redis cache read timeouts on checkout", "redis")
        rel = claim("c2", "the Redis cache is fine", "redis")
        unrel = claim("c3", "billing export job finished", "redis")
        got = self.eng.retrieve(new, [rel, unrel])
        self.assertIn("c2", [c.id for c, _ in got])

    def test_retrieval_is_capped_at_top_k(self):
        new = claim("c1", "Redis memory pressure", "redis")
        many = [claim(f"c{i}", "Redis memory pressure observed", "redis") for i in range(2, 12)]
        self.assertLessEqual(len(self.eng.retrieve(new, many)), 5)


class TestStage2Cooldown(unittest.TestCase):
    """Stops the same conflict re-firing every window (§7.3)."""

    def setUp(self):
        self.eng = ContradictionEngine()

    def test_a_pair_is_in_cooldown_after_adjudication(self):
        self.eng.mark_adjudicated("a", "b", now=1000.0)
        self.assertTrue(self.eng.in_cooldown("a", "b", now=1100.0))

    def test_cooldown_expires_after_five_minutes(self):
        self.eng.mark_adjudicated("a", "b", now=1000.0)
        self.assertFalse(self.eng.in_cooldown("a", "b", now=1000.0 + 301))

    def test_cooldown_is_order_independent(self):
        # (a,b) and (b,a) are the same pair; keying naively would let the same
        # conflict fire twice by swapping the argument order.
        self.eng.mark_adjudicated("a", "b", now=1000.0)
        self.assertTrue(self.eng.in_cooldown("b", "a", now=1100.0))


class TestStage3Adjudication(unittest.TestCase):

    def setUp(self):
        self.eng = ContradictionEngine()
        self.a = claim("c1", "Redis primary memory measured at 40 percent", "redis")
        self.b = claim("c2", "Application logs show cache read timeouts", "redis",
                       role="Support Engineer")

    def test_opposed_above_the_gate_is_actionable(self):
        v = run(self.eng.adjudicate(self.a, self.b, call_llm=verdict("OPPOSED", 0.88)))
        self.assertTrue(v.is_actionable)

    def test_independent_is_ALSO_actionable(self):
        # §7.1's design note: two engineers using different evidence to argue
        # about the same conclusion is the more common real-incident case, and
        # a keyword system cannot see it at all.
        v = run(self.eng.adjudicate(self.a, self.b, call_llm=verdict("INDEPENDENT", 0.86)))
        self.assertTrue(v.is_actionable)

    def test_agreement_is_recorded_but_never_interrupts(self):
        for rel in ("AGREES", "REFINES"):
            with self.subTest(rel=rel):
                v = run(self.eng.adjudicate(self.a, self.b, call_llm=verdict(rel, 0.99)))
                self.assertFalse(v.is_actionable)

    def test_low_confidence_stays_silent(self):
        v = run(self.eng.adjudicate(self.a, self.b, call_llm=verdict("OPPOSED", 0.5)))
        self.assertFalse(v.is_actionable)
        self.assertLess(v.confidence, ADJUDICATION_CONFIDENCE_GATE)

    def test_an_llm_failure_defaults_to_SILENCE_not_a_false_alarm(self):
        async def broken(system, user):
            raise RuntimeError("groq unreachable")

        v = run(self.eng.adjudicate(self.a, self.b, call_llm=broken))
        self.assertFalse(v.is_actionable, "a vendor outage must not interrupt the room")


class TestFullPipeline(unittest.TestCase):

    def setUp(self):
        self.eng = ContradictionEngine()

    def test_the_headline_case_fires_exactly_once(self):
        # v6's S4 gate: "contradiction fires exactly once".
        mem = claim("clm-mem40", "Redis primary memory measured at 40 percent", "redis")
        timeouts = claim("clm-timeouts", "Redis cache read timeouts observed", "redis",
                         role="Support Engineer")

        first = run(self.eng.evaluate(timeouts, [mem], call_llm=verdict("INDEPENDENT", 0.86), now=100.0, use_panel=False))
        self.assertIsNotNone(first)
        self.assertEqual(first[0].id, "clm-mem40")

        # Same pair again inside the cooldown — must stay silent.
        second = run(self.eng.evaluate(timeouts, [mem], call_llm=verdict("INDEPENDENT", 0.86), now=150.0, use_panel=False))
        self.assertIsNone(second, "the same conflict fired twice")

    def test_a_hypothesis_never_triggers_the_engine(self):
        hyp = claim("h1", "Redis might be evicting keys", "redis", status="HYPOTHESIS")
        mem = claim("c1", "Redis memory at 40 percent", "redis")
        self.assertIsNone(run(self.eng.evaluate(hyp, [mem], call_llm=verdict("OPPOSED", 0.99), use_panel=False)))

    def test_unrelated_entities_never_reach_the_llm(self):
        called = {"n": 0}

        async def counting(system, user):
            called["n"] += 1
            return json.dumps({"relation": "OPPOSED", "confidence": 0.99})

        new = claim("c1", "Redis memory at 40 percent", "redis")
        other = claim("c2", "Postgres memory at 40 percent", "postgres")
        run(self.eng.evaluate(new, [other], call_llm=counting, use_panel=False))
        self.assertEqual(called["n"], 0, "scoping should have prevented any LLM cost")


if __name__ == "__main__":
    unittest.main()


class TestPanelIsTheDefaultJudge(unittest.TestCase):
    """
    The Panel replaced the single judge in production, and nothing downstream
    would notice if that silently regressed — `evaluate` returns the same
    shape either way. So the wiring itself is pinned here.
    """

    def test_evaluate_uses_the_panel_unless_told_otherwise(self):
        seen: list[object] = []

        async def spy(system, user, **kwargs):
            seen.append(kwargs.get("models"))
            return json.dumps({"relation": "AGREES", "confidence": 0.9, "why": "x"})

        eng = ContradictionEngine()
        new = claim("c1", "Redis cache read timeouts observed", "redis",
                    role="Support Engineer")
        other = claim("c2", "Redis primary memory measured at 40 percent", "redis")

        run(eng.evaluate(new, [other], call_llm=spy))

        # Two analysts, each pinned to its own model. One call with models=None
        # would mean the single judge is still running.
        self.assertGreaterEqual(len(seen), 2, "the panel did not convene")
        self.assertTrue(all(m for m in seen), "a persona ran unpinned")
        self.assertEqual(len(set(map(tuple, seen))), len(seen),
                         "personas shared a model — independence lost")
