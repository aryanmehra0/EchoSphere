import os
import unittest
from unittest import mock

from app.application.services.session import SessionRegistry, IncidentSession, TooManySessions
from app.domain.models import Claim


class TestMultiChannelIsolation(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = SessionRegistry()

    def test_channels_are_isolated(self) -> None:
        chan_a = "inc-team-alpha"
        chan_b = "inc-team-beta"

        session_a = self.registry.get_or_create(chan_a)
        session_b = self.registry.get_or_create(chan_b)

        self.assertNotEqual(session_a, session_b)
        self.assertEqual(session_a.channel, chan_a)
        self.assertEqual(session_b.channel, chan_b)

        # Add claim to channel A
        claim_a = Claim(
            id="claim-a1",
            text="Redis latency is 42ms.",
            epistemic_status="FACT",
            speaker_role="DevOps Lead",
            confidence=1.0,
            entity="redis",
            at=1000,
        )
        session_a.ledger.upsert_claim(claim_a)

        # Verify channel A has the claim, but channel B has zero claims
        self.assertIn("claim-a1", session_a.ledger.claims)
        self.assertNotIn("claim-a1", session_b.ledger.claims)
        self.assertEqual(len(session_b.ledger.claims), 0)

    def test_reset_channel_leaves_other_channels_intact(self) -> None:
        chan_a = "inc-room-101"
        chan_b = "inc-room-102"

        session_a = self.registry.get_or_create(chan_a)
        session_b = self.registry.get_or_create(chan_b)

        # Add claims to both
        session_a.ledger.upsert_claim(Claim(
            id="c-a", text="Service A degraded.", epistemic_status="FACT",
            speaker_role="IC", confidence=1.0, entity="service-a", at=1000,
        ))
        session_b.ledger.upsert_claim(Claim(
            id="c-b", text="Service B healthy.", epistemic_status="FACT",
            speaker_role="IC", confidence=1.0, entity="service-b", at=1000,
        ))

        # Reset channel A only
        self.registry.reset(chan_a)

        # Channel A has been reset
        fresh_a = self.registry.get_or_create(chan_a)
        self.assertEqual(len(fresh_a.ledger.claims), 0)

        # Channel B still has its claim
        fresh_b = self.registry.get_or_create(chan_b)
        self.assertIn("c-b", fresh_b.ledger.claims)

    def test_default_channel_fallback(self) -> None:
        default_session = self.registry.current()
        self.assertEqual(default_session.channel, self.registry._default)

        # None or empty string resolves to current default
        self.assertEqual(self.registry.get_or_create(None), default_session)
        self.assertEqual(self.registry.get_or_create(""), default_session)
        self.assertEqual(self.registry.get_or_create("   "), default_session)

    def test_a_genuinely_new_channel_beyond_the_cap_is_refused(self) -> None:
        """
        Regression: `get_or_create` used to grow `_sessions` without bound —
        several unauthenticated-by-design endpoints (`/observer/transcript`
        chief among them) accept an arbitrary `channel` and would each
        create a full `IncidentSession` (Ledger, DeltaHub, a Postgres
        snapshot query) for it, a straightforward memory/DB-exhaustion path
        for a caller sending many distinct channel names.
        """
        with mock.patch.dict(os.environ, {"MAX_CONCURRENT_INCIDENTS": "3"}):
            self.registry.get_or_create("inc-1")
            self.registry.get_or_create("inc-2")
            self.registry.get_or_create("inc-3")

            with self.assertRaises(TooManySessions):
                self.registry.get_or_create("inc-4")

    def test_an_existing_channel_is_never_refused_by_the_cap(self) -> None:
        """The cap blocks GROWTH only — a channel already in use must always
        resolve, even once the process is at (or over) the limit."""
        with mock.patch.dict(os.environ, {"MAX_CONCURRENT_INCIDENTS": "1"}):
            first = self.registry.get_or_create("inc-established")
            with self.assertRaises(TooManySessions):
                self.registry.get_or_create("inc-new")
            # The already-established channel still resolves.
            self.assertEqual(self.registry.get_or_create("inc-established"), first)


if __name__ == "__main__":
    unittest.main()

