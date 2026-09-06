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



class LedgerDoesNotDoubleCount(unittest.TestCase):
    """
    Cross-window duplicates — the half `_dedupe_claims` cannot see.

    Extraction dedupes within ONE window. The same sentence extracted from two
    overlapping windows produced two Ledger rows, which a Tier 3 run caught
    only on the third consecutive pass because it depends on where the window
    boundary happens to fall.

    Double-counting is not cosmetic: the Ledger is what Echo reads aloud and
    what the contradiction engine scopes over, so a claim recorded twice is a
    fact that looks corroborated when one person said it once.
    """

    def setUp(self):
        from app.ledger import Ledger
        from app.models import Claim

        self.Claim = Claim
        self.ledger = Ledger()

    def claim(self, cid, text, role="DevOps Lead", status="OBSERVED", conf=1.0):
        return self.Claim(
            id=cid, text=text, entity="redis", epistemic_status=status,
            speaker_role=role, confidence=conf, at=1,
        )

    def test_the_same_speaker_saying_it_twice_is_one_row(self):
        self.ledger.upsert_claim(self.claim("c1", "The cache is fine"))
        self.ledger.upsert_claim(self.claim("c2", "the cache is fine."))
        self.assertEqual(len(self.ledger.claims), 1)

    def test_two_speakers_agreeing_is_TWO_rows(self):
        # Agreement between two people is a finding, and merging it would
        # erase one person's attribution.
        self.ledger.upsert_claim(self.claim("c1", "cache read timeouts", role="DevOps Lead"))
        self.ledger.upsert_claim(self.claim("c2", "cache read timeouts", role="Support Engineer"))
        self.assertEqual(len(self.ledger.claims), 2)

    def test_a_repeat_cannot_promote_a_guess_to_a_fact(self):
        self.ledger.upsert_claim(self.claim("c1", "Redis might be evicting keys",
                                            status="HYPOTHESIS", conf=0.7))
        self.ledger.upsert_claim(self.claim("c2", "Redis might be evicting keys",
                                            status="OBSERVED", conf=1.0))
        kept = next(iter(self.ledger.claims.values()))
        self.assertEqual(kept.epistemic_status, "HYPOTHESIS")
        self.assertLessEqual(kept.confidence, 0.7)

    def test_different_claims_are_both_kept(self):
        self.ledger.upsert_claim(self.claim("c1", "Memory is at 40 percent"))
        self.ledger.upsert_claim(self.claim("c2", "The cache is fine"))
        self.assertEqual(len(self.ledger.claims), 2)

    def test_updating_a_known_row_by_id_still_works(self):
        self.ledger.upsert_claim(self.claim("c1", "Memory is at 40 percent"))
        self.ledger.upsert_claim(self.claim("c1", "Memory is at 95 percent"))
        self.assertEqual(len(self.ledger.claims), 1)
        self.assertIn("95", self.ledger.claims["c1"].text)

class HedgeConfidenceCap(unittest.TestCase):
    """
    A hedge cannot be 100% certain, whoever labelled it.

    The cap used to live inside the downgrade branch, so it ran only when WE
    reclassified an OBSERVED claim. A model that returned HYPOTHESIS on its own
    kept whatever confidence it liked, and the board showed

        [OPEN QUESTION] Redis might be evicting keys ... 100%

    which is the original defect wearing different clothes: right pane, and a
    number beside it still claiming certainty about a guess.
    """

    WINDOW = "[DevOps Lead] Datadog looks like Redis might be evicting keys."

    def _one(self, status: str, confidence: float) -> dict:
        out = validate_extraction(
            {"claims": [{
                "text": "Redis might be evicting keys",
                "epistemicStatus": status,
                "speakerRole": "DevOps Lead",
                "confidence": confidence,
            }]},
            window_text=self.WINDOW,
        )
        return out["claims"][0]

    def test_a_downgraded_hedge_is_capped(self) -> None:
        c = self._one("OBSERVED", 1.0)
        self.assertEqual(c["epistemicStatus"], "HYPOTHESIS")
        self.assertLessEqual(c["confidence"], 0.8)

    def test_a_hedge_the_model_already_called_a_hypothesis_is_capped_too(self) -> None:
        c = self._one("HYPOTHESIS", 1.0)
        self.assertLessEqual(c["confidence"], 0.8, "100% certainty about a guess")

    def test_the_cap_is_a_ceiling_not_a_floor(self) -> None:
        # A model that is already appropriately unsure must not be talked UP.
        self.assertAlmostEqual(self._one("HYPOTHESIS", 0.5)["confidence"], 0.5)

    def test_an_unhedged_fact_keeps_its_confidence(self) -> None:
        out = validate_extraction(
            {"claims": [{
                "text": "Memory is at 40 percent",
                "epistemicStatus": "OBSERVED",
                "speakerRole": "DevOps Lead",
                "confidence": 1.0,
            }]},
            window_text=self.WINDOW,
        )
        c = out["claims"][0]
        self.assertEqual(c["epistemicStatus"], "OBSERVED")
        self.assertAlmostEqual(c["confidence"], 1.0)


if __name__ == "__main__":
    unittest.main()


class AFailedExtractionKeepsTheWords(unittest.TestCase):
    """
    An utterance must survive a failed extraction — §4.4 robustness.

    `drain()` empties the window BEFORE extraction runs, so an extraction that
    raised used to take the frames with it: the words were spoken and then
    simply were not in the record. Groq's per-minute limit is per organisation,
    so this fires exactly when the bridge is busiest — the analysis matters
    most and the claims vanish quietest.

    An evidence ledger that silently drops evidence under load is not one.
    """

    def setUp(self):
        from app.extraction import TurnWindow
        from app.models import Transcript

        self.window = TurnWindow()
        self.Transcript = Transcript

    def frame(self, mid: str, text: str):
        return self.Transcript(
            message_id=mid, uid=1001, role="DevOps Lead", text=text,
            is_final=True, at=1,
        )

    def test_requeued_frames_are_extracted_next_time(self):
        self.window.add(self.frame("m1", "Memory is at 40 percent"))
        drained = self.window.drain()
        self.assertEqual(len(drained), 1)
        self.assertEqual(self.window.frames, [])

        for f in drained:
            self.window.requeue(f)

        self.assertEqual(len(self.window.frames), 1)
        self.assertIn("40 percent", self.window.frames[0].text)

    def test_a_requeue_does_not_double_count_on_redelivery(self):
        # The transport can redeliver; a retry of ours must not make the
        # window accept the same utterance twice on top of the requeued copy.
        self.window.add(self.frame("m1", "Memory is at 40 percent"))
        for f in self.window.drain():
            self.window.requeue(f)

        accepted = self.window.add(self.frame("m1", "Memory is at 40 percent"))
        self.assertFalse(accepted, "the same message id was accepted twice")
        self.assertEqual(len(self.window.frames), 1)

    def test_requeue_restarts_the_silence_timer(self):
        # A requeued frame carrying a stale timestamp would look overdue and
        # flush instantly — straight back into the failure it came from.
        self.window.add(self.frame("m1", "Memory is at 40 percent"))
        for f in self.window.drain():
            self.window.requeue(f)
        self.assertFalse(
            self.window.should_flush(),
            "a just-requeued window must wait for its silence budget",
        )
