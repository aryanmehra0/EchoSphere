import shutil
import tempfile
import unittest
from pathlib import Path

from app.domain.ledger import Ledger
from app.domain.models import Claim, Entity, Link, Task, now_ms
from app.infrastructure import event_store


class TestEventStore(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="echo_test_events_"))
        self.db_path = self.temp_dir / "test_events.db"
        event_store.init_db(self.db_path)

    def tearDown(self) -> None:
        event_store.close()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_record_event_and_load_snapshots(self) -> None:
        channel = "test-inc-1"
        claim = Claim(
            id="c1",
            text="Redis primary latency spiked to 450ms",
            epistemic_status="OBSERVED",
            speaker_role="DevOps Lead",
            confidence=0.98,
            entity="redis-primary",
        )
        seq1 = event_store.record_event(claim, channel)
        self.assertIsNotNone(seq1)
        self.assertEqual(seq1, 1)

        entity = Entity(
            id="redis-primary",
            label="Redis Primary",
            kind="datastore",
            status="WARNING",
            metric="450ms latency",
        )
        seq2 = event_store.record_event(entity, channel)
        self.assertIsNotNone(seq2)
        self.assertEqual(seq2, 2)

        # Load materialized snapshots
        snapshots = event_store.load_channel_snapshots(channel)
        self.assertIn("claims", snapshots)
        self.assertIn("entities", snapshots)
        self.assertEqual(len(snapshots["claims"]), 1)
        self.assertEqual(snapshots["claims"][0]["id"], "c1")
        self.assertEqual(snapshots["claims"][0]["text"], "Redis primary latency spiked to 450ms")
        self.assertEqual(len(snapshots["entities"]), 1)
        self.assertEqual(snapshots["entities"][0]["id"], "redis-primary")
        self.assertEqual(snapshots["entities"][0]["status"], "WARNING")

    def test_append_only_event_replay(self) -> None:
        channel = "test-inc-2"
        # Record sequential status transitions for same entity: OK -> WARNING -> CRITICAL
        e1 = Entity(id="auth-svc", label="Auth Service", kind="service", status="OK")
        event_store.record_event(e1, channel)

        e2 = Entity(id="auth-svc", label="Auth Service", kind="service", status="WARNING")
        event_store.record_event(e2, channel)

        e3 = Entity(id="auth-svc", label="Auth Service", kind="service", status="CRITICAL")
        event_store.record_event(e3, channel)

        # Replay events
        events = event_store.replay_events(channel)
        self.assertEqual(len(events), 3)
        self.assertEqual(events[0]["payload"]["status"], "OK")
        self.assertEqual(events[1]["payload"]["status"], "WARNING")
        self.assertEqual(events[2]["payload"]["status"], "CRITICAL")

        # Snapshot shows current materialized state
        snapshots = event_store.load_channel_snapshots(channel)
        self.assertEqual(len(snapshots["entities"]), 1)
        self.assertEqual(snapshots["entities"][0]["status"], "CRITICAL")

    def test_ledger_rehydration_from_sqlite(self) -> None:
        channel = "test-inc-3"
        ledger = Ledger(channel=channel)

        ledger.upsert_claim(
            Claim(
                id="c10",
                text="Postgres DB pool exhausted",
                epistemic_status="OBSERVED",
                speaker_role="DB Admin",
                confidence=0.95,
            )
        )
        ledger.upsert_entity(
            Entity(
                id="postgres-primary",
                label="Postgres Primary",
                kind="datastore",
                status="CRITICAL",
            )
        )

        # Create fresh ledger and restore
        fresh_ledger = Ledger(channel=channel)
        # Force Postgres store._enabled to False so it exercises the SQLite fallback
        import asyncio
        restored_count = asyncio.run(fresh_ledger.restore())
        self.assertGreaterEqual(restored_count, 2)
        self.assertIn("c10", fresh_ledger.claims)
        self.assertIn("postgres-primary", fresh_ledger.entities)
        self.assertEqual(fresh_ledger.claims["c10"].text, "Postgres DB pool exhausted")
        self.assertEqual(fresh_ledger.entities["postgres-primary"].status, "CRITICAL")


if __name__ == "__main__":
    unittest.main()

