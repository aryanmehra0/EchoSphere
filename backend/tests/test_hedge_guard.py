"""
The fact/assumption split, enforced in code — §6.

A live run on Aug 31 filed BOTH of these from a single spoken sentence:

    "Datadog indicates Redis might be evicting keys"   OBSERVED   100%
    "Redis might be evicting keys"                     HYPOTHESIS

The same guess, recorded simultaneously as a measured fact and as an open
question, on the same dashboard, at the same second. Naming a tool was enough
to make the model read a hedge as an observation.

This is the worst failure available to this product. The entire claim is that
it separates what is known from what is assumed, and that screen shows it
doing both at once — in front of a judge, it refutes the pitch by itself.

Two guards, both structural rather than prompt instructions, because the
prompt already said to do this and did not.
"""

from __future__ import annotations

import unittest

from app.extraction import validate_extraction


def claim(text: str, status: str, role: str = "DevOps Lead", confidence: float = 1.0):
    return {
        "text": text,
        "epistemicStatus": status,
        "speakerRole": role,
        "confidence": confidence,
    }


def run(claims: list[dict]) -> list[dict]:
    return validate_extraction({"claims": claims})["claims"]


class HedgeCannotBeAFact(unittest.TestCase):

    def test_the_exact_row_that_shipped_as_a_fact(self):
        out = run([claim("Datadog indicates Redis might be evicting keys", "OBSERVED")])
        self.assertEqual(out[0]["epistemicStatus"], "HYPOTHESIS")

    def test_a_downgraded_claim_loses_its_certainty(self):
        # "100%" printed beside a guess is its own kind of lie, and the
        # dashboard renders that number right next to the row.
        out = run([claim("Redis might be evicting keys", "OBSERVED", confidence=1.0)])
        self.assertLessEqual(out[0]["confidence"], 0.8)

    def test_every_common_hedge(self):
        for text in [
            "Redis might be evicting keys",
            "It could be the connection pool",
            "This is probably a cache issue",
            "It looks like the shard is saturated",
            "Seems like the deploy is involved",
            "I think the queue is backing up",
            "Possibly a DNS problem",
            "My guess is the replica lagged",
            "I suspect the rollout",
            "Pretty sure it is the cache",
        ]:
            with self.subTest(text=text):
                out = run([claim(text, "OBSERVED")])
                self.assertEqual(
                    out[0]["epistemicStatus"], "HYPOTHESIS",
                    f"{text!r} hedges and must not be filed as a fact",
                )

    def test_naming_a_tool_does_not_launder_a_guess(self):
        # The specific mechanism of the live failure.
        for text in [
            "Datadog indicates Redis might be evicting keys",
            "Grafana shows it could be memory pressure",
            "The dashboard suggests it seems like a network issue",
        ]:
            with self.subTest(text=text):
                out = run([claim(text, "TOOL_RESULT")])
                self.assertEqual(out[0]["epistemicStatus"], "HYPOTHESIS")

    def test_real_measurements_are_left_alone(self):
        # The guard must not eat the other half of the demo. A measurement
        # wrongly filed as a guess is just as broken in the other direction.
        for text in [
            "Memory is at 40 percent",
            "The cache is fine",
            "massive spike in 500s on checkout",
            "Latency is through the roof",
            "Tickets are flooding in.",
            "application logs are definitely showing cache read timeouts on the checkout path",
            "Users say their carts empty the second they hit purchase.",
        ]:
            with self.subTest(text=text):
                out = run([claim(text, "OBSERVED")])
                self.assertEqual(
                    out[0]["epistemicStatus"], "OBSERVED",
                    f"{text!r} is a measurement and must stay a fact",
                )
                self.assertEqual(out[0]["confidence"], 1.0)


class OneAssertionOneRow(unittest.TestCase):

    def test_the_duplicate_pair_collapses(self):
        out = run([
            claim("Datadog indicates Redis might be evicting keys", "OBSERVED"),
            claim("Redis might be evicting keys", "HYPOTHESIS", confidence=0.8),
        ])
        self.assertEqual(len(out), 1, "one sentence produced two Ledger rows")
        self.assertEqual(out[0]["epistemicStatus"], "HYPOTHESIS")

    def test_caution_wins_when_duplicates_disagree(self):
        """A claim recorded once as a fact and once as a guess is a guess."""
        out = run([
            claim("Redis might be evicting keys", "OBSERVED"),
            claim("Redis might be evicting keys", "HYPOTHESIS", confidence=0.7),
        ])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["epistemicStatus"], "HYPOTHESIS")
        self.assertLessEqual(out[0]["confidence"], 0.8)

    def test_the_fuller_wording_survives(self):
        out = run([
            claim("Redis might be evicting keys", "HYPOTHESIS"),
            claim("Datadog indicates Redis might be evicting keys", "HYPOTHESIS"),
        ])
        self.assertEqual(len(out), 1)
        self.assertIn("Datadog", out[0]["text"])

    def test_different_claims_about_one_entity_are_NOT_merged(self):
        # The demo turns on exactly this pair staying separate.
        out = run([
            claim("Memory is at 40 percent", "OBSERVED"),
            claim("The cache is fine", "OBSERVED"),
        ])
        self.assertEqual(len(out), 2)

    def test_two_speakers_saying_similar_things_stay_separate(self):
        # Agreement between two people is a finding, not a duplicate — and
        # merging them would erase one person's attribution.
        out = run([
            claim("cache read timeouts on checkout", "OBSERVED", role="DevOps Lead"),
            claim("cache read timeouts on checkout", "OBSERVED", role="Support Engineer"),
        ])
        self.assertEqual(len(out), 2)


if __name__ == "__main__":
    unittest.main()
