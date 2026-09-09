import tempfile
import unittest
from pathlib import Path

from app.application.services.session import IncidentSession
from app.domain.models import Claim, Entity
from app.infrastructure import event_store


class TestSessionRehydration(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp_dir.name) / "test_rehydrate.db"
        event_store.init_db(self.db_path)

    def tearDown(self) -> None:
        event_store.close()
        self.tmp_dir.cleanup()

    def test_ledger_rehydrate_from_snapshot_wire_and_snake(self) -> None:
        session = IncidentSession("test-chan-1")
        # Ensure fresh state
        session.ledger.claims.clear()
        session.ledger.entities.clear()

        snapshots = {
            "entities": [
                {
                    "id": "redis-1",
                    "label": "Redis Primary",
                    "kind": "datastore",
                    "status": "CRITICAL",
                    "aliases": ["the cache", "redis"],
                }
            ],
            "claims": [
                {
                    "id": "c-1",
                    "text": "Redis memory is at 95 percent",
                    "epistemicStatus": "OBSERVED",
                    "speakerRole": "DevOps Lead",
                    "confidence": 0.95,
                    "entity": "redis-1",
                }
            ],
        }

        session.ledger.rehydrate_from_snapshot(snapshots)
        self.assertIn("redis-1", session.ledger.entities)
        self.assertEqual(session.ledger.entities["redis-1"].label, "Redis Primary")
        self.assertIn("c-1", session.ledger.claims)
        self.assertEqual(session.ledger.claims["c-1"].speaker_role, "DevOps Lead")
        self.assertEqual(session.ledger.claims["c-1"].epistemic_status, "OBSERVED")

    def test_session_cold_start_rehydration_from_event_store(self) -> None:
        channel = "inc-rehydrate-test"
        session1 = IncidentSession(channel)

        # Upsert records into session 1
        claim = Claim(
            id="claim-101",
            text="Cache latency spiked to 250ms",
            epistemic_status="OBSERVED",
            speaker_role="SRE",
            confidence=0.9,
            entity="redis",
        )
        entity = Entity(
            id="redis",
            label="Redis Cache",
            kind="datastore",
            status="WARNING",
            aliases=["cache"],
        )
        session1.ledger.upsert_claim(claim)
        session1.ledger.upsert_entity(entity)

        # Confirm recorded in SQLite
        snapshots = event_store.load_channel_snapshots(channel)
        self.assertTrue(len(snapshots.get("claims", [])) >= 1)
        self.assertTrue(len(snapshots.get("entities", [])) >= 1)

        # Simulate process restart by instantiating a fresh IncidentSession for the same channel
        session2 = IncidentSession(channel)

        self.assertIn("claim-101", session2.ledger.claims)
        self.assertEqual(session2.ledger.claims["claim-101"].text, "Cache latency spiked to 250ms")
        self.assertIn("redis", session2.ledger.entities)
        self.assertEqual(session2.ledger.entities["redis"].label, "Redis Cache")
        self.assertGreater(session2.hub.seq, 0)

