"""
Unit tests for Redis Stream Extraction Worker and Ingestion Decoupling.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from app.application.services.session import registry
from app.application.services.worker import GROUP_NAME, STREAM_NAME, StreamExtractionWorker
from app.domain.models import Transcript
from app.infrastructure import redis_bus


class TestStreamExtractionWorker(IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.channel = "test-worker-chan"
        self.session = registry.reset(self.channel)

    async def test_worker_lifecycle_start_and_stop(self) -> None:
        worker = StreamExtractionWorker(consumer_name="test-worker-1")
        self.assertFalse(worker._running)

        await worker.start()
        self.assertTrue(worker._running)
        self.assertIsNotNone(worker._task)

        await worker.stop()
        self.assertFalse(worker._running)
        self.assertIsNone(worker._task)

    @patch("app.infrastructure.redis_bus.is_enabled", return_value=True)
    @patch("app.infrastructure.redis_bus.xgroup_create", new_callable=AsyncMock)
    @patch("app.infrastructure.redis_bus.xreadgroup", new_callable=AsyncMock)
    @patch("app.infrastructure.redis_bus.xautoclaim", new_callable=AsyncMock, return_value=[])
    @patch("app.infrastructure.redis_bus.xack", new_callable=AsyncMock)
    @patch("app.application.services.pipeline.run_if_ready", new_callable=AsyncMock)
    async def test_worker_processes_and_acks_stream_entry(
        self,
        mock_pipeline_run: AsyncMock,
        mock_xack: AsyncMock,
        mock_xautoclaim: AsyncMock,
        mock_xreadgroup: AsyncMock,
        mock_xgroup_create: AsyncMock,
        mock_is_enabled: MagicMock,
    ) -> None:
        worker = StreamExtractionWorker(consumer_name="test-worker-mock")
        worker._running = True

        # Mock xreadgroup to return 1 item, then cancel worker
        mock_xreadgroup.side_effect = [
            [("1000-0", {"channel": self.channel, "message_id": "m-123"})],
            asyncio.CancelledError(),
        ]

        try:
            await worker._run_loop()
        except asyncio.CancelledError:
            pass

        mock_xgroup_create.assert_awaited_once_with(STREAM_NAME, GROUP_NAME, start_id="$", mkstream=True)
        mock_pipeline_run.assert_awaited_once()
        mock_xack.assert_awaited_once_with(STREAM_NAME, GROUP_NAME, "1000-0")

    def test_consumer_name_is_stable_across_instances_on_the_same_host(self) -> None:
        """
        Regression: the default consumer name used to include `id(self)`,
        which changes every process run — a restarted worker got a brand
        new consumer name and could never reclaim entries left pending under
        its predecessor's name via `xautoclaim`.
        """
        first = StreamExtractionWorker()
        second = StreamExtractionWorker()
        self.assertEqual(first.consumer_name, second.consumer_name)

    @patch("app.infrastructure.redis_bus.is_enabled", return_value=True)
    @patch("app.infrastructure.redis_bus.xgroup_create", new_callable=AsyncMock)
    @patch("app.infrastructure.redis_bus.xreadgroup", new_callable=AsyncMock)
    @patch("app.infrastructure.redis_bus.xautoclaim", new_callable=AsyncMock)
    @patch("app.infrastructure.redis_bus.xack", new_callable=AsyncMock)
    @patch("app.application.services.pipeline.run_if_ready", new_callable=AsyncMock)
    async def test_reclaimed_entries_are_processed_and_acked(
        self,
        mock_pipeline_run: AsyncMock,
        mock_xack: AsyncMock,
        mock_xautoclaim: AsyncMock,
        mock_xreadgroup: AsyncMock,
        mock_xgroup_create: AsyncMock,
        mock_is_enabled: MagicMock,
    ) -> None:
        """A stale entry reclaimed via `xautoclaim` (left pending by a
        consumer that crashed before acking) is processed exactly like a
        freshly-read one, then acked so it leaves the PEL for good."""
        worker = StreamExtractionWorker(consumer_name="test-worker-reclaim")
        worker._running = True

        # xreadgroup finds nothing new; the reclaim on this same first
        # iteration is what surfaces the stale entry. Raise on the second
        # iteration to end the loop — `xautoclaim` only runs once per
        # `reclaim_interval_s`, so it would not be called again in time for
        # a side_effect on IT to end the test.
        mock_xreadgroup.side_effect = [[], asyncio.CancelledError()]
        mock_xautoclaim.return_value = [("999-0", {"channel": self.channel, "message_id": "m-stale"})]

        try:
            await worker._run_loop()
        except asyncio.CancelledError:
            pass

        mock_xautoclaim.assert_awaited_once()
        mock_pipeline_run.assert_awaited_once()
        mock_xack.assert_awaited_once_with(STREAM_NAME, GROUP_NAME, "999-0")

    @patch("app.infrastructure.redis_bus.is_enabled", return_value=False)
    async def test_a_second_transcript_does_not_spawn_a_redundant_pipeline_task(
        self, mock_is_enabled: MagicMock,
    ) -> None:
        """
        Regression: under sustained LLM slowness (Groq rate-limit backoff),
        every incoming transcript used to spawn its own pipeline task, all
        queuing on the same `pipeline_lock` — pure overhead, since whichever
        one runs first will drain everything accumulated by the time it
        gets the lock. A second transcript arriving while one task is
        already spawned-but-not-yet-running must not spawn another.
        """
        from app.web.routers.ingest import ingest_transcript

        payload_1 = {
            "channel": self.channel, "text": "first utterance",
            "role": "DevOps Lead", "isFinal": True,
        }
        payload_2 = {
            "channel": self.channel, "text": "second utterance, arriving fast",
            "role": "DevOps Lead", "isFinal": True,
        }

        with patch.object(self.session, "spawn_pipeline") as mock_spawn:
            await ingest_transcript(payload_1)
            self.assertTrue(self.session.pipeline_pending)
            mock_spawn.assert_called_once()

            await ingest_transcript(payload_2)
            # Still just the one call — the second transcript saw
            # `pipeline_pending` already True and skipped spawning.
            mock_spawn.assert_called_once()

            # Close the coroutine handed to the mock so it isn't left
            # dangling with an "unawaited coroutine" warning.
            mock_spawn.call_args[0][0].close()

    @patch("app.infrastructure.redis_bus.is_enabled", return_value=False)
    @patch("app.infrastructure.redis_bus.xadd", new_callable=AsyncMock)
    async def test_ingest_falls_back_when_redis_disabled(
        self,
        mock_xadd: AsyncMock,
        mock_is_enabled: MagicMock,
    ) -> None:
        from app.web.routers.ingest import ingest_transcript

        payload = {
            "channel": self.channel,
            "text": "Latency is reaching 800ms on payments API",
            "role": "DevOps Lead",
            "isFinal": True,
        }

        with patch.object(self.session, "spawn_pipeline") as mock_spawn:
            res = await ingest_transcript(payload)
            self.assertTrue(res["accepted"])
            self.assertTrue(res["queued"])
            self.assertFalse(res["stream"])
            mock_xadd.assert_not_awaited()
            mock_spawn.assert_called_once()
            # Close coroutine passed to mock spawn to silence unawaited warning
            mock_spawn.call_args[0][0].close()

    @patch("app.infrastructure.redis_bus.is_enabled", return_value=True)
    @patch("app.infrastructure.redis_bus.xadd", new_callable=AsyncMock, return_value="1789-0")
    async def test_ingest_pushes_to_stream_when_redis_enabled(
        self,
        mock_xadd: AsyncMock,
        mock_is_enabled: MagicMock,
    ) -> None:
        from app.web.routers.ingest import ingest_transcript

        payload = {
            "channel": self.channel,
            "text": "Error rates are climbing across all pods",
            "role": "Site Reliability Engineer",
            "isFinal": True,
        }

        with patch.object(self.session, "spawn_pipeline") as mock_spawn:
            res = await ingest_transcript(payload)
            self.assertTrue(res["accepted"])
            self.assertTrue(res["queued"])
            self.assertTrue(res["stream"])
            mock_xadd.assert_awaited_once()
            mock_spawn.assert_not_called()
