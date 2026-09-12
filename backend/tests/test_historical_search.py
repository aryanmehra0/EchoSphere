"""
Unit tests for Cross-Incident Semantic RAG Search Engine (Qdrant & Fast Loop Tool).
"""

from __future__ import annotations

import unittest
from fastapi.testclient import TestClient

from app.main import app
from app.application.services.session import registry
from app.domain.models import Claim, TimelineEvent, now_ms
from app.infrastructure import vector_store


class TestHistoricalSearch(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.channel = "inc-historical-test"

    async def test_vector_store_index_and_search_postmortem(self) -> None:
        # Index a historical postmortem
        arch_id = "pm-test-101"
        indexed = await vector_store.index_postmortem(
            archive_id=arch_id,
            channel="inc-past-alpha",
            title="Redis Memory Exhaustion Incident",
            summary="High rate of unevicted session keys led to redis cluster memory saturation.",
            markdown="# Postmortem Alpha\nDetails on memory usage.",
            key_claims=["Redis memory at 99%", "Maxmemory reached on shard 2"],
        )
        self.assertTrue(indexed)

        # Search for semantically related terms
        results = await vector_store.search_historical_postmortems(
            query_text="redis memory saturation and key eviction",
            top_k=3,
            score_threshold=0.20,
        )
        self.assertGreater(len(results), 0)
        top = results[0]
        self.assertEqual(top["archiveId"], arch_id)
        self.assertEqual(top["channel"], "inc-past-alpha")
        self.assertIn("memory", top["summary"].lower())

    async def test_incident_search_endpoint(self) -> None:
        # Seed an archive into vector store
        arch_id = "pm-test-auth-403"
        await vector_store.index_postmortem(
            archive_id=arch_id,
            channel="inc-past-beta",
            title="Auth Gateway Certificate Expiry",
            summary="Expired TLS certificates on auth ingress rejected client handshakes.",
            markdown="# Postmortem Beta",
            key_claims=["TLS handshake failure", "Cert validity expired"],
        )

        # Query via REST endpoint
        res = self.client.get("/incident/search?query=TLS+certificate+expiry&top_k=2")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["query"], "TLS certificate expiry")
        self.assertGreater(data["count"], 0)
        self.assertEqual(data["results"][0]["archiveId"], arch_id)

    async def test_query_historical_incidents_tool_enforces_rule1(self) -> None:
        arch_id = "pm-test-db-pool"
        await vector_store.index_postmortem(
            archive_id=arch_id,
            channel="inc-past-gamma",
            title="Postgres Connection Pool Saturation",
            summary="Postgres pool exhausted caused by leaked connection handles in checkout service.",
            markdown="# Postmortem Gamma",
            key_claims=["Active connections at ceiling 500"],
        )

        res = self.client.post(
            "/tools/query_historical_incidents",
            json={"query": "connection pool exhaustion postgres"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertGreater(data["count"], 0)
        summary = data["summary"]
        self.assertIn(f"In past incident {arch_id}", summary)
        # Rule 1 verification: causal phrase "caused by" must be scrubbed
        self.assertNotIn("caused by", summary)
        self.assertIn("correlated with", summary)

    async def test_incident_reset_indexes_postmortem(self) -> None:
        session = registry.reset(self.channel)
        session.ledger.upsert_claim(Claim(
            id="claim-hist-1",
            text="Checkout service latency exceeded 4500ms.",
            epistemic_status="FACT",
            speaker_role="DevOps Lead",
            confidence=1.0,
            entity="checkout",
            at=now_ms(),
        ))
        session.ledger.add_timeline(TimelineEvent(
            id="tl-hist-1",
            kind="observation",
            text="Checkout service latency spiking",
            actor="DevOps Lead",
            at=now_ms(),
        ))

        # Reset should auto-archive and index into vector_store
        res = self.client.post(f"/incident/reset?channel={self.channel}")
        self.assertEqual(res.status_code, 200)

        # Now search vector store for checkout latency
        results = await vector_store.search_historical_postmortems(
            query_text="checkout latency spiking",
            top_k=5,
            score_threshold=0.20,
        )
        self.assertGreater(len(results), 0)
        found = any(self.channel in r.get("channel", "") for r in results)
        self.assertTrue(found)

    async def test_backfill_recovers_a_postmortem_indexed_during_a_qdrant_outage(self) -> None:
        """
        Regression: `search_historical_postmortems` only ever queries Qdrant
        once `_client` is set — a postmortem indexed to the in-memory
        fallback during an outage became permanently invisible to search the
        moment Qdrant reconnected, with nothing to move it over. This
        simulates that outage-then-reconnect sequence directly against the
        module's own state rather than actually stopping the Qdrant
        container.
        """
        arch_id = "pm-outage-test-1"
        # Running this file in isolation (rather than the full suite, where
        # test_vector_and_redis.py connects first) means Qdrant may not be
        # connected yet — connect explicitly so "restore the real state"
        # below actually restores a CONNECTED state, not whatever this
        # process happened to start with.
        if not vector_store.is_enabled():
            await vector_store.connect()
        real_client, real_enabled = vector_store._client, vector_store._enabled
        try:
            # Simulate the outage: index while Qdrant looks unreachable.
            vector_store._enabled = False
            vector_store._client = None
            indexed = await vector_store.index_postmortem(
                archive_id=arch_id,
                channel="inc-outage-alpha",
                title="Kafka Consumer Lag Incident",
                summary="Consumer group fell behind during a broker rolling restart.",
                markdown="# Postmortem\nConsumer lag details.",
                key_claims=["Consumer lag exceeded 50000 messages"],
            )
            self.assertTrue(indexed)
            self.assertTrue(any(item["archiveId"] == arch_id for item in vector_store._in_memory_historical))

            # Simulate the reconnect.
            vector_store._client = real_client
            vector_store._enabled = real_enabled

            backfilled_count = await vector_store.backfill_historical()
            self.assertGreaterEqual(backfilled_count, 1)
            self.assertFalse(
                any(item["archiveId"] == arch_id for item in vector_store._in_memory_historical),
                "backfilled entry should be removed from the in-memory fallback",
            )

            results = await vector_store.search_historical_postmortems(
                query_text="kafka consumer lag broker restart",
                top_k=5,
                score_threshold=0.20,
            )
            self.assertTrue(any(r["archiveId"] == arch_id for r in results))
        finally:
            vector_store._client, vector_store._enabled = real_client, real_enabled
            vector_store._in_memory_historical[:] = [
                item for item in vector_store._in_memory_historical if item["archiveId"] != arch_id
            ]

