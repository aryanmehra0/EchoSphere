import asyncio
import json
import unittest
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from app.domain.ledger import Ledger
from app.domain.models import Claim
from app.infrastructure.deltas import DeltaHub
from app.main import app


class TestSnapshotCache(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_caching_and_invalidation(self) -> None:
        hub = DeltaHub()
        ledger = Ledger("test-chan")
        c = Claim(
            id="c1",
            text="Initial claim",
            epistemic_status="OBSERVED",
            speaker_role="SRE",
            confidence=0.9,
        )
        ledger.upsert_claim(c)

        # First snapshot generation: cache miss -> serialized & cached
        snap1 = await hub.get_cached_snapshot_json(ledger)
        self.assertIn("c1", snap1)
        data1 = json.loads(snap1)
        self.assertEqual(data1["kind"], "SNAPSHOT")
        self.assertEqual(data1["seq"], hub.seq)

        # Second snapshot request: cache hit (same seq, cached string returned)
        snap2 = await hub.get_cached_snapshot_json(ledger)
        self.assertIs(snap1, snap2)

        # Publish new delta: invalidates cache
        await hub.publish({"claim": {"id": "c2", "text": "Second claim"}})
        self.assertGreater(hub.seq, data1["seq"])

        # Third snapshot request: cache miss -> newly serialized with updated seq
        snap3 = await hub.get_cached_snapshot_json(ledger)
        data3 = json.loads(snap3)
        self.assertEqual(data3["seq"], hub.seq)
        self.assertIsNot(snap1, snap3)


class TestWebSocketSnapshotDelivery(unittest.TestCase):
    def test_websocket_hello_receives_snapshot(self) -> None:
        client = TestClient(app)
        with client.websocket_connect("/ws/deltas") as ws:
            ws.send_json({"kind": "HELLO", "lastSeq": None})
            raw = ws.receive_text()
            data = json.loads(raw)
            self.assertEqual(data.get("kind"), "SNAPSHOT")
            self.assertIn("state", data)


if __name__ == "__main__":
    unittest.main()

