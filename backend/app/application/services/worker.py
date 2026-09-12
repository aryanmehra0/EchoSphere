"""
Asynchronous Redis Stream Extraction Worker — v6 §9 & Production Ingestion.

Decouples Turn Window extraction and Deliberation Panel execution from the
FastAPI HTTP request loop. Reads unacknowledged transcript events from
Redis Streams using consumer groups (`XREADGROUP`), serializes processing
per-channel with distributed locks, and acknowledges completed jobs with `XACK`.
"""

from __future__ import annotations

import asyncio
import logging
import socket
from typing import Any

from app.application.services import pipeline
from app.application.services.session import registry
from app.infrastructure import redis_bus
from app.web.deps import speech

log = logging.getLogger("echo.worker")

STREAM_NAME = "echosphere:ingest:events"
GROUP_NAME = "echosphere-extractors"


class StreamExtractionWorker:
    """Background worker that continuously processes transcript events from Redis Streams."""

    def __init__(self, consumer_name: str | None = None) -> None:
        # Stable across restarts — NOT `id(self)`. A consumer name that
        # changes every process run means a crashed/restarted worker can
        # never reclaim its own predecessor's Pending Entries List: Redis
        # tracks PEL ownership by consumer name, and a name nobody will ever
        # use again leaves those entries stuck, unacked, forever. Multiple
        # processes on the same host would collide on this name — fine
        # today (docker-compose runs exactly one backend instance), and
        # `worker.py`'s own module docstring already flags horizontal
        # scaling as a later change, at which point this needs a
        # per-instance identifier from the deployment (pod name, task ARN),
        # not a random one generated here.
        self.consumer_name = consumer_name or f"worker-{socket.gethostname()}"
        self._running = False
        self._task: asyncio.Task[Any] | None = None

    async def start(self) -> None:
        """Start the worker loop in the background."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name="stream-extraction-worker")
        log.info("worker: StreamExtractionWorker started as consumer '%s'", self.consumer_name)

    async def stop(self) -> None:
        """Gracefully stop the worker loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("worker: StreamExtractionWorker stopped")

    async def _run_loop(self) -> None:
        # Wait until Redis is connected if starting during app startup
        while self._running and not redis_bus.is_enabled():
            await asyncio.sleep(1.0)

        # Ensure the consumer group exists
        await redis_bus.xgroup_create(STREAM_NAME, GROUP_NAME, start_id="$", mkstream=True)

        # Reclaim entries left in another consumer's Pending Entries List
        # (a prior run that crashed/restarted before acking) on this cadence
        # rather than every loop iteration — `xautoclaim` is one more Redis
        # round trip per call, and nothing needs the reclaim to happen
        # faster than this to still make real progress on a stuck entry.
        last_reclaim = 0.0
        reclaim_interval_s = 30.0

        while self._running:
            try:
                if not redis_bus.is_enabled():
                    await asyncio.sleep(1.0)
                    continue

                entries = await redis_bus.xreadgroup(
                    group=GROUP_NAME,
                    consumer=self.consumer_name,
                    stream=STREAM_NAME,
                    count=5,
                    block_ms=2000,
                )

                now = asyncio.get_running_loop().time()
                if now - last_reclaim >= reclaim_interval_s:
                    last_reclaim = now
                    reclaimed = await redis_bus.xautoclaim(
                        STREAM_NAME, GROUP_NAME, self.consumer_name,
                    )
                    if reclaimed:
                        log.info("worker: reclaimed %d stale pending entr(ies)", len(reclaimed))
                        entries = [*entries, *reclaimed]

                if not entries:
                    continue

                for entry_id, payload in entries:
                    channel = payload.get("channel")
                    try:
                        current = registry.get_or_create(channel)
                        # Acquire distributed lock per channel to prevent concurrent extraction race conditions
                        async with redis_bus.lock(f"pipeline:{current.channel}", timeout_seconds=120) as acquired:
                            if acquired:
                                await pipeline.run_if_ready(current, speech(current))
                        # Acknowledge processed message
                        await redis_bus.xack(STREAM_NAME, GROUP_NAME, entry_id)
                    except Exception as exc:
                        log.exception("worker: failed processing stream entry %s for channel %s: %s", entry_id, channel, exc)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.warning("worker: loop exception: %s", exc)
                await asyncio.sleep(1.0)


# Singleton instance for the process
extraction_worker = StreamExtractionWorker()

