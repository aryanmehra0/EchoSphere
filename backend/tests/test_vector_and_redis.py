"""
Unit tests for Redis event bus, Qdrant vector store, and Agora agent tool binding.
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from app.domain.ledger import Ledger
from app.domain.models import Claim
from app.infrastructure import redis_bus, vector_store
from app.infrastructure import agora_agent


class TestVectorAndRedis(unittest.IsolatedAsyncioTestCase):
    async def test_redis_bus_operations(self) -> None:
        """Test Redis connection, XADD and XREAD with active container."""
        connected = await redis_bus.connect()
        self.assertTrue(connected, "Redis container on port 6379 should connect")

        msg_id = await redis_bus.xadd("test_stream_unit", {"field1": "val1", "num": 123})
        self.assertIsNotNone(msg_id)

        events = await redis_bus.xread("test_stream_unit", last_id="0-0", count=5, block_ms=500)
        self.assertGreaterEqual(len(events), 1)
        entry_id, payload = events[-1]
        self.assertEqual(payload.get("field1"), "val1")
        self.assertEqual(payload.get("num"), 123)

        stat = await redis_bus.status()
        self.assertTrue(stat["enabled"])
        self.assertTrue(stat["connected"])
        await redis_bus.disconnect()

    async def test_vector_store_operations(self) -> None:
        """Test Qdrant vector store upsert, similarity search, and channel purge."""
        connected = await vector_store.connect()
        self.assertTrue(connected, "Qdrant container on port 6333 should connect")

        chan = "unit-test-chan"
        c1 = await vector_store.upsert_claim(chan, "c1", "Database connection pool exhausted", {"entity": "postgres"})
        c2 = await vector_store.upsert_claim(chan, "c2", "Redis cache latency is normal at 1ms", {"entity": "redis"})
        self.assertTrue(c1)
        self.assertTrue(c2)

        results = await vector_store.search_similar_claims(chan, "Connection pool full in postgres", top_k=1, score_threshold=0.4)
        self.assertGreaterEqual(len(results), 1)
        self.assertEqual(results[0]["claimId"], "c1")

        await vector_store.purge_channel(chan)
        after_purge = await vector_store.search_similar_claims(chan, "Connection pool full", top_k=1, score_threshold=0.4)
        self.assertEqual(len(after_purge), 0)
        await vector_store.disconnect()

    def test_agora_agent_tool_binding(self) -> None:
        """Test that Agora agent wire properties include tools when supplied."""
        _area, _async_agora, AgoraAgent, DeepgramSTT, MiniMaxTTS, OpenAI = agora_agent._require_sdk()
        client = MagicMock()
        client.app_id = "test_app_id"
        client.app_certificate = "test_cert"

        stt = DeepgramSTT(model="nova-3", language="en")
        llm = OpenAI(model="gpt-4o-mini", max_tokens=512)
        tts = MiniMaxTTS(model="speech_2_6_turbo", voice_id="English_captivating_female1")

        tools = [
            {
                "type": "function",
                "function": {
                    "name": "query_incident_state",
                    "description": "Read ledger",
                    "parameters": {"type": "object", "properties": {"scope": {"type": "string"}}},
                },
                "server": {
                    "url": "https://tunnel.trycloudflare.com/tools/query_incident_state",
                    "method": "POST",
                    "headers": {"Content-Type": "application/json"},
                },
            }
        ]

        agent = AgoraAgent(
            client=client,
            instructions="test",
            failure_message="",
            max_history=12,
            advanced_features={"enable_rtm": True, "enable_tools": True},
        ).with_stt(stt).with_llm(llm).with_tts(tts)

        # Apply the fix
        agent._llm["tools"] = tools

        session = agent.create_async_session(channel="test-c", agent_uid="101", remote_uids=["*"], token="dummy_token")
        skip_cat, allow_cat = session._vendor_validation_categories(None)
        props = session._build_start_properties({"token": "dummy_token"}, skip_vendor_validation_categories=skip_cat, allow_missing_vendor_categories=allow_cat)

        self.assertIn("llm", props)
        self.assertIn("tools", props["llm"])
        self.assertEqual(props["llm"]["tools"][0]["function"]["name"], "query_incident_state")
        self.assertEqual(props["llm"]["tools"][0]["server"]["url"], "https://tunnel.trycloudflare.com/tools/query_incident_state")


if __name__ == "__main__":
    unittest.main()

