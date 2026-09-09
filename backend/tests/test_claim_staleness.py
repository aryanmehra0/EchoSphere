import unittest

from app.domain.ledger import Ledger
from app.domain.models import Claim


class TestClaimStaleness(unittest.TestCase):
    def test_claim_temporal_defaults(self) -> None:
        c = Claim(
            id="c1",
            text="Redis packet drop is 92%",
            epistemic_status="OBSERVED",
            speaker_role="SRE Lead",
            confidence=0.99,
            at=10000,
            ttl_seconds=300,
        )
        self.assertEqual(c.valid_from, 10000)
        self.assertIsNone(c.valid_until)
        self.assertEqual(c.ttl_seconds, 300)
        self.assertEqual(c.lifecycle, "ACTIVE")

    def test_evaluate_staleness_transitions_claims(self) -> None:
        ledger = Ledger(channel="test-staleness")

        # Claim 1: Measured at t=10,000ms with TTL 300s (expires at 310,000ms)
        c1 = Claim(
            id="c1",
            text="Redis memory is 95%",
            epistemic_status="OBSERVED",
            speaker_role="DevOps Lead",
            confidence=0.95,
            at=10000,
            valid_from=10000,
            ttl_seconds=300,
        )
        ledger.upsert_claim(c1)

        # Claim 2: Permanent fact with no TTL (e.g. PR-204 deployed)
        c2 = Claim(
            id="c2",
            text="PR 204 deployed at 14:00",
            epistemic_status="OBSERVED",
            speaker_role="Release Eng",
            confidence=1.0,
            at=10000,
            valid_from=10000,
            ttl_seconds=None,
        )
        ledger.upsert_claim(c2)

        # At t=200,000ms (200s elapsed, within 300s TTL): c1 is still ACTIVE
        stale = ledger.evaluate_staleness(now=200000)
        self.assertEqual(len(stale), 0)
        self.assertEqual(ledger.claims["c1"].lifecycle, "ACTIVE")
        self.assertEqual(len(ledger.established()), 2)

        # At t=400,000ms (390s elapsed, beyond 300s TTL): c1 transitions to STALE
        stale = ledger.evaluate_staleness(now=400000)
        self.assertEqual(stale, ["c1"])
        self.assertEqual(ledger.claims["c1"].lifecycle, "STALE")

        # c2 remains ACTIVE because it has no TTL
        self.assertEqual(ledger.claims["c2"].lifecycle, "ACTIVE")

        # established() excludes STALE claims by default to protect Echo's voice answers
        active_established = ledger.established()
        self.assertEqual(len(active_established), 1)
        self.assertEqual(active_established[0].id, "c2")

        # established(include_stale=True) returns both for historical audit
        all_established = ledger.established(include_stale=True)
        self.assertEqual(len(all_established), 2)


if __name__ == "__main__":
    unittest.main()

