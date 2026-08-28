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
