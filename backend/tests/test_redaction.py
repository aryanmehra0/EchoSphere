"""PII redaction — v6 §10.4."""

from __future__ import annotations

import unittest

from app.redaction import redact


class TestRedaction(unittest.TestCase):

    def test_email_is_replaced_with_a_typed_placeholder(self):
        r = redact("jane@acme.com says her cart emptied")
        self.assertNotIn("jane@acme.com", r.text)
        self.assertIn("[EMAIL_1]", r.text)
        self.assertEqual(r.replacements["[EMAIL_1]"], "jane@acme.com")

    def test_card_numbers_never_survive(self):
        r = redact("the card 4242 4242 4242 4242 was double charged")
        self.assertNotIn("4242 4242 4242 4242", r.text)
        self.assertIn("[CARD_1]", r.text)

    def test_multiple_of_a_kind_are_numbered(self):
        r = redact("email a@b.com and c@d.com")
        self.assertIn("[EMAIL_1]", r.text)
        self.assertIn("[EMAIL_2]", r.text)

    def test_placeholders_keep_the_sentence_parseable(self):
        # Typed placeholders rather than blanket masking, so the extraction
        # model still knows WHAT was removed and can build a coherent claim.
        r = redact("order 88913 for jane@acme.com failed")
        self.assertIn("[ORDER_1]", r.text)
        self.assertIn("[EMAIL_1]", r.text)
        self.assertIn("failed", r.text)

    # -- the important half: what must NOT be redacted -------------------

    def test_aws_regions_survive(self):
        # "us-east-1a" is the single detail the whole demo turns on. Redacting
        # it as an IP or an order id would gut the incident.
        r = redact("90 percent packet loss in us-east-1a")
        self.assertIn("us-east-1a", r.text)

    def test_infrastructure_nouns_survive(self):
        r = redact("redis memory is at 40 percent")
        self.assertIn("redis", r.text.lower())

    def test_status_codes_survive(self):
        r = redact("we are seeing 5xx errors on checkout")
        self.assertIn("5xx", r.text)

    def test_plain_metrics_are_not_mistaken_for_phone_numbers(self):
        r = redact("latency is 4200 milliseconds")
        self.assertIn("4200", r.text)

    def test_clean_text_is_returned_untouched(self):
        original = "DevOps measured Redis memory at 40 percent"
        r = redact(original)
        self.assertEqual(r.text, original)
        self.assertEqual(r.count, 0)


if __name__ == "__main__":
    unittest.main()


class CredentialsMustNeverReachTheRecord(unittest.TestCase):
    """
    Reported live, and the worst class of defect this product has had.

    Spoken on the bridge:

        "The admin password is Hunter two, and the API key is
         sk-test-12345"

    There was NO credential pattern in `_PATTERNS` at all, and redaction ran
    only inside `extraction.extract()` — after `store.save()` and after
    `hub.publish()`. So every layer faithfully recorded it: the transcript
    rendered it, the Ledger filed two OBSERVED claims at 100% confidence,
    Postgres persisted both rows, and when the room asked "what is the admin
    password?" Echo READ IT BACK ALOUD from its own record.

    Two fixes are pinned here: the patterns, and the fact that a spoken secret
    is several tokens rather than one.
    """

    def _clean(self, text: str) -> str:
        return redact(text).text

    def test_the_exact_reported_utterance_is_redacted(self):
        out = self._clean(
            "The admin password is Hunter two, and the API key is "
            "s k dash test dash one two three four five."
        )
        self.assertNotIn("hunter", out.lower())
        # The spelled-out key must not survive as a tail. A first attempt used
        # `\S+` for the value and published "k dash test dash one two three".
        self.assertNotIn("dash test dash", out.lower())
        self.assertIn("SECRET", out)

    def test_a_question_asking_for_a_secret_is_also_redacted(self):
        # "What is the password of admin?" must not be stored verbatim
        # either: the question names the field and invites the answer.
        self.assertIn("SECRET", self._clean("What is the password of admin?"))

    def test_vendor_shaped_keys_are_caught_with_no_introducing_phrase(self):
        for raw in ("sk-test-12345", "AKIAIOSFODNN7EXAMPLE",
                    "ghp_abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9"):
            with self.subTest(raw=raw):
                self.assertIn("SECRET", self._clean(f"here it is {raw}"))

    def test_ordinary_incident_speech_is_NOT_redacted(self):
        """
        Over-redaction has its own cost: "[SECRET_1]" where somebody said
        "the key metric is latency" destroys the record it exists to protect.
        `key` in particular is ordinary incident English.
        """
        for raw in (
            "Memory is at 40 percent on the primary Redis shard.",
            "The key metric is checkout latency.",
            "Application logs show cache read timeouts on checkout.",
            "us-east-1a is degraded and we see 500 errors.",
            "Nobody has checked the network path between checkout and the cache.",
        ):
            with self.subTest(raw=raw):
                self.assertEqual(self._clean(raw), raw)
