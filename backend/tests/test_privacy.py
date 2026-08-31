"""
Consent and retention — §10.5.

The feature's only real promise is that a suspended turn is not kept. These
tests exist to make that promise checkable rather than asserted, because it is
exactly the kind of thing that quietly stops being true.
"""

from __future__ import annotations

import unittest

from app.privacy import PrivacyGate, PrivacyState


class SpokenControl(unittest.TestCase):

    def setUp(self):
        self.gate = PrivacyGate()

    def test_recording_is_the_default(self):
        # An incident bridge that silently failed to record itself would be
        # its own kind of failure.
        self.assertTrue(self.gate.state.recording)
        self.assertEqual(self.gate.evaluate("Redis memory is at 40 percent", "DevOps Lead").action,
                         "record")

    def test_off_the_record_suspends(self):
        d = self.gate.evaluate("Can we go off the record for a second", "DevOps Lead")
        self.assertEqual(d.action, "pause")
        self.assertFalse(self.gate.state.recording)
        self.assertIn("Off the record", d.announce)

    def test_everything_after_the_pause_is_dropped(self):
        self.gate.evaluate("off the record", "DevOps Lead")
        for text in ["Priya is being managed out next week",
                     "the customer is threatening to sue"]:
            self.assertEqual(self.gate.evaluate(text, "Support Engineer").action, "drop")
        self.assertEqual(self.gate.state.suspended_turns, 2)

    def test_a_dropped_turn_leaves_a_COUNT_and_nothing_else(self):
        """
        The core promise. If this ever regresses into storing the text 'just
        for the audit log', the feature has become the problem it solves.
        """
        secret = "the CTO is resigning on Friday"
        self.gate.evaluate("off the record", "DevOps Lead")
        self.gate.evaluate(secret, "Support Engineer")

        blob = repr(self.gate.state) + repr(self.gate.state.to_wire())
        self.assertNotIn("CTO", blob)
        self.assertNotIn("resigning", blob)
        self.assertEqual(self.gate.state.suspended_turns, 1)

    def test_resume_brings_it_back(self):
        self.gate.evaluate("off the record", "DevOps Lead")
        d = self.gate.evaluate("ok, back on the record", "DevOps Lead")
        self.assertEqual(d.action, "resume")
        self.assertTrue(self.gate.state.recording)
        self.assertEqual(self.gate.evaluate("memory is at 40 percent", "DevOps Lead").action,
                         "record")

    def test_the_control_phrase_itself_is_minuted_both_ways(self):
        # "Priya took the bridge off the record at 14:32" is what a review
        # needs, and it reveals nothing about what was then said.
        self.assertTrue(self.gate.evaluate("off the record", "DevOps Lead").keeps_text)
        self.assertTrue(self.gate.evaluate("back on the record", "DevOps Lead").keeps_text)

    def test_pausing_twice_is_not_an_error(self):
        self.gate.evaluate("off the record", "DevOps Lead")
        # A second "off the record" from someone who missed the first must not
        # flip it back on, and must not be recorded either.
        self.assertEqual(self.gate.evaluate("off the record", "Support Engineer").action, "drop")
        self.assertFalse(self.gate.state.recording)

    def test_resume_while_already_recording_changes_nothing(self):
        d = self.gate.evaluate("we are back on the record", "DevOps Lead")
        self.assertEqual(d.action, "record")
        self.assertTrue(self.gate.state.recording)

    def test_who_flipped_it_is_attributed(self):
        self.gate.evaluate("off the record", "Database Admin")
        self.assertEqual(self.gate.state.changed_by, "Database Admin")

    def test_ordinary_incident_speech_never_trips_the_control(self):
        # A false pause is unrecoverable in the sense that matters: the room
        # keeps talking and nothing is minuted.
        for text in [
            "the record count is off by three",
            "we should record this metric",
            "check the DNS record",
            "recording latency is high",
            "off-by-one in the shard index",
        ]:
            with self.subTest(text=text):
                self.assertEqual(self.gate.evaluate(text, "DevOps Lead").action, "record",
                                 f"{text!r} should not have paused recording")


class AnnouncementsAreSayable(unittest.TestCase):
    """
    §10.5 rule 3 requires Echo to CONFIRM a recording change out loud, and §6
    Rule 1 refuses any sentence without an attributed source. Those two rules
    collided on the day the consent gate shipped: the tripwire rejected
    "Recording resumed.", the exception escaped, and the whole ingest endpoint
    returned a 500.

    These lines assert nothing about the incident — they report Echo's own
    state — so they belong in the no-claim set. Pinned here because the fix
    touched the epistemic guard, and that guard must never be loosened by
    accident.
    """

    def test_both_announcements_pass_the_rule_1_tripwire(self):
        from app.utterance import validate

        gate = PrivacyGate()
        pause = gate.evaluate("off the record", "DevOps Lead").announce
        resume = gate.evaluate("back on the record", "DevOps Lead").announce

        for line in (pause, resume):
            with self.subTest(line=line):
                self.assertTrue(line, "an announcement must not be empty")
                validate(line)   # raises EpistemicViolation on failure

    def test_the_no_claim_list_did_not_become_a_loophole(self):
        """
        The exemption is anchored prefixes naming things Echo does — not a
        general escape. An unattributed FINDING must still be refused.
        """
        from app.utterance import EpistemicViolation, validate

        with self.assertRaises(EpistemicViolation):
            validate("Redis memory is at 40 percent.")


class Inventory(unittest.TestCase):

    def test_inventory_reports_zero_audio_always(self):
        gate = PrivacyGate(PrivacyState(recording=True))
        inv = gate.inventory(claims=7, entities=2, transcripts=4, redactions=3)
        self.assertEqual(inv["held"]["rawAudio"], 0)
        self.assertEqual(inv["held"]["claims"], 7)
        self.assertEqual(inv["redaction"]["spansReplaced"], 3)
        self.assertFalse(inv["retention"]["survivesRestart"])

    def test_inventory_counts_suspended_turns(self):
        gate = PrivacyGate()
        gate.evaluate("off the record", "DevOps Lead")
        gate.evaluate("something private", "Support Engineer")
        inv = gate.inventory(claims=0, entities=0, transcripts=0, redactions=0)
        self.assertEqual(inv["suspended"]["turnsDropped"], 1)
        self.assertFalse(inv["recording"])


if __name__ == "__main__":
    unittest.main()
