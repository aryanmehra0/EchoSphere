"""
The epistemic tests — Zone 3's half of v6 §6.

The frontend's Tier 1 suite asserts that the demo FIXTURE obeys Rules 1–3.
These assert something stronger: that the code which composes Echo's live
speech *cannot* produce a violating sentence, because `/speak` sends our exact
words rather than a model's paraphrase.

Run:  .venv/Scripts/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import unittest

from app.bridge import BridgeController
from app.models import Claim, Unchecked
from app.utterance import (
    EpistemicViolation,
    close_out,
    contradiction_intervention,
    tension_intervention,
    validate,
)


def observed(cid: str, text: str, role: str, entity: str = "redis") -> Claim:
    return Claim(
        id=cid, text=text, epistemic_status="OBSERVED",
        speaker_role=role, confidence=0.95, entity=entity,
    )


class TestRuleOneAttribution(unittest.TestCase):
    """Rule 1 — a claim without a source is not sayable."""

    def test_a_claim_cannot_exist_without_a_speaker(self):
        # Enforced at the point of ingestion, where it can still be repaired.
        with self.assertRaises(ValueError):
            Claim(id="c1", text="memory is at 40 percent",
                  epistemic_status="OBSERVED", speaker_role="", confidence=0.9)

    def test_unattributed_finding_is_rejected(self):
        with self.assertRaises(EpistemicViolation):
            validate("Redis memory is at 40 percent and the cache is fine.")

    def test_attributed_finding_passes(self):
        validate("DevOps reported redis memory at 40 percent.")


class TestRuleTwoCausation(unittest.TestCase):
    """Rule 2 — causation is always interrogative."""

    def test_v5_diagnosing_lines_are_refused(self):
        # These are the exact sentences v6 §6.3 tabulates as violating the brief.
        for line in [
            "DevOps reported that points to a network partition.",
            "Support reported the cache read timeouts are caused by packet loss.",
            "DevOps measured this: the root cause is a network partition.",
            "DevOps reported the problem is the cache rather than a network fault.",
        ]:
            with self.subTest(line=line):
                with self.assertRaises(EpistemicViolation):
                    validate(line)

    def test_the_required_closeout_sentence_survives(self):
        # The tripwire's negative lookahead exists for this one line. If someone
        # "simplifies" the regex, this test is what catches it.
        validate(
            "DevOps reported checkout recovered. Root cause is not established."
        )

    def test_surfacing_a_conflict_is_allowed(self):
        validate(
            "DevOps reported memory at 40 percent. Support reported read timeouts. "
            "Those are different properties, so both can be true."
        )


class TestComposers(unittest.TestCase):

    def setUp(self):
        self.a = observed("clm-mem", "Redis primary memory measured at 40 percent", "DevOps Lead")
        self.b = observed("clm-to", "Application logs show cache read timeouts", "Support Engineer")
        self.gap = Unchecked(
            id="unc-net",
            description="The network path between checkout and the cache is unverified",
            suggested_owner="DevOps Lead",
        )

    def test_contradiction_names_both_sources_and_the_gap(self):
        line = contradiction_intervention(self.a, self.b, relation="INDEPENDENT", gap=self.gap)
        self.assertIn("DevOps", line)
        self.assertIn("Support", line)
        self.assertIn("Who owns that?", line)
        # It must not resolve the conflict itself.
        self.assertNotIn("root cause", line.lower())

    def test_contradiction_never_proposes_a_cause(self):
        line = contradiction_intervention(self.a, self.b, relation="OPPOSED", gap=self.gap)
        validate(line)  # raises if it slipped into diagnosis

    def test_tension_restates_the_record_rather_than_scolding(self):
        line = tension_intervention([self.a, self.b], self.gap)
        self.assertTrue(line.startswith("Pausing for ten seconds"))
        self.assertIn("DevOps", line)

    def test_closeout_states_root_cause_is_not_established(self):
        line = close_out(
            [self.a, self.b], [], [self.gap], minutes=14, timeline_count=23,
        )
        self.assertIn("Root cause is not established", line)
        self.assertIn("DevOps", line)

    def test_closeout_lists_what_was_never_resolved(self):
        line = close_out([self.a], [], [self.gap], minutes=14, timeline_count=23)
        self.assertIn("Unresolved", line)
        self.assertIn("network path", line.lower())


class TestRuleThreeInferredNeverSpoken(unittest.TestCase):
    """
    Rule 3 — the structural half.

    Inferred claims are filtered out of every Bridge payload, so the model
    cannot route around the rule: they never enter its context at all.
    """

    def test_inferred_claims_are_stripped(self):
        human = observed("c1", "memory measured at 40 percent", "DevOps Lead")
        inferred = Claim(
            id="c2", text="Packet loss would isolate checkout from the cache",
            epistemic_status="INFERRED", speaker_role="Echo", confidence=0.81,
        )

        kept = BridgeController.strip_inferred([human, inferred])
        self.assertEqual([c.id for c in kept], ["c1"])

    def test_a_ledger_of_only_inferences_yields_nothing_sayable(self):
        inferred = Claim(
            id="c2", text="derived", epistemic_status="INFERRED",
            speaker_role="Echo", confidence=0.8,
        )
        self.assertEqual(BridgeController.strip_inferred([inferred]), [])


if __name__ == "__main__":
    unittest.main()
