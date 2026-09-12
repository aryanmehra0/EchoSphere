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

from app.adapters.agora_bridge import BridgeController
from app.ledger import Ledger
from app.models import Claim, Unchecked
from app.utterance import (
    EpistemicViolation,
    close_out,
    contradiction_intervention,
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

    # `test_tension_restates_the_record_rather_than_scolding` was removed with
    # the RTI subsystem — the composer it exercised had no producer. The Rule 1
    # and Rule 2 coverage it contributed is unchanged: every remaining composer
    # is still asserted to pass `validate()`.

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


class TestRecap(unittest.TestCase):
    """
    `Ledger.recap()` — the context handed to a replacement Fast Loop agent
    when a new speaker's join forces Agora's fixed `remote_rtc_uids` to be
    rebuilt from scratch, per this method's own docstring. Had zero test
    coverage before this.
    """

    def test_inferred_claims_never_appear_in_the_recap(self):
        ledger = Ledger(channel="test-recap")
        ledger.upsert_claim(Claim(
            id="c1", text="Redis memory is at 80 percent",
            epistemic_status="OBSERVED", speaker_role="DevOps Lead",
            confidence=0.9, at=1000,
        ))
        ledger.upsert_claim(Claim(
            id="c2", text="Redis is probably the root cause",
            epistemic_status="INFERRED", speaker_role="Echo",
            confidence=0.5, at=2000,
        ))

        text = ledger.recap()
        self.assertIn("Redis memory is at 80 percent", text)
        self.assertNotIn("probably the root cause", text)

    def test_inferred_claims_do_not_crowd_out_older_sourceable_ones(self):
        """
        Regression: filtering INFERRED claims used to happen AFTER slicing
        to `max_claims`, so if several of the most-recent N claims happened
        to be INFERRED, those slots were wasted — older non-INFERRED claims
        that would otherwise have fit inside the window were silently
        dropped from the recap entirely, undermining the exact guarantee
        `recap()` exists to provide to a rejoining agent.
        """
        ledger = Ledger(channel="test-recap-crowding")
        # One real, sourceable claim, oldest.
        ledger.upsert_claim(Claim(
            id="real-1", text="Checkout latency spiked to 900ms",
            epistemic_status="OBSERVED", speaker_role="DevOps Lead",
            confidence=0.9, at=1000,
        ))
        # Three INFERRED claims, all more recent, filling the rest of a
        # max_claims=3 window if the filter ran after the slice.
        for i in range(3):
            ledger.upsert_claim(Claim(
                id=f"inferred-{i}", text=f"Echo's own guess {i}",
                epistemic_status="INFERRED", speaker_role="Echo",
                confidence=0.4, at=2000 + i,
            ))

        text = ledger.recap(max_claims=3)
        self.assertIn(
            "Checkout latency spiked to 900ms", text,
            "an older sourceable claim was crowded out by INFERRED claims that never appear anyway",
        )


if __name__ == "__main__":
    unittest.main()
