"""
The Redis Event Bus & Streaming Backbone — v6 §9 & §10.

Provides durable event streaming (Redis Streams), distributed state caching,
and distributed locks for the Fast Loop and Slow Loop.

Degrades gracefully to no-op / in-memory if Redis is offline (v6 §13 degradation principle).
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from app.infrastructure import config

log = logging.getLogger("echo.redis_bus")

_redis: Any = None
_enabled: bool = False
_last_error: str | None = None


def is_enabled() -> bool:
    return _enabled


async def connect() -> bool:
    """
    Connect to Redis or degrade gracefully. Never raises.
    Returns True when Redis connection is live.
    """
    global _redis, _enabled, _last_error
    try:
        import redis.asyncio as aioredis
    except ImportError:
        _last_error = "redis package not installed"
        log.warning("redis_bus: redis package not installed; running in degraded in-memory mode")
        _enabled = False
        return False

    url = config.redis_url()
    if not url:
        _enabled = False
        return False

    try:
        client = aioredis.from_url(
            url,
            encoding="utf-8",
            decode_responses=True,
            socket_timeout=3.0,
            socket_connect_timeout=3.0,
        )
        await client.ping()
        _redis = client
        _enabled = True
        _last_error = None
        log.info("redis_bus: connected successfully to %s", url)
        return True
    except Exception as exc:
        _last_error = str(exc)
        _enabled = False
        _redis = None
        log.warning("redis_bus: connection to %s failed (%s); degrading gracefully", url, exc)
        return False


async def disconnect() -> None:
    global _redis, _enabled
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:
            pass
        _redis = None
    _enabled = False


def get_client() -> Any:
    return _redis if _enabled else None


async def xadd(stream: str, data: dict[str, Any], maxlen: int = 50_000) -> str | None:
    """
    Append an event to a Redis Stream with approximate trimming.
    Returns message ID or None if Redis is disabled.

    `maxlen` is a SOFT cap against unbounded memory growth, not a durability
    guarantee — the actual guarantee comes from acking promptly plus
    `xautoclaim` reclaiming what a dead consumer left pending, not from
    keeping every unacked entry forever. It was 2000 (a busy incident, many
    small transcript/claim events, can plausibly exceed that within a single
    session) and worth raising specifically because trimming an entry that a
    crashed consumer never acked makes it permanently unrecoverable — even a
    perfect `xautoclaim` can't reclaim an entry Redis has already dropped.
    """
    client = get_client()
    if client is None:
        return None
    try:
        # Flatten non-string/scalar values to JSON strings for Redis
        payload: dict[str, str] = {}
        for k, v in data.items():
            if isinstance(v, (dict, list)):
                payload[k] = json.dumps(v, default=str)
            elif v is None:
                payload[k] = ""
            else:
                payload[k] = str(v)
        msg_id = await client.xadd(stream, payload, maxlen=maxlen, approximate=True)
        return str(msg_id)
    except Exception as exc:
        log.warning("redis_bus: xadd to %s failed: %s", stream, exc)
        return None


async def xread(
    stream: str,
    last_id: str = "$",
    count: int = 50,
    block_ms: int = 1000,
) -> list[tuple[str, dict[str, Any]]]:
    """
    Read events from a Redis Stream.
    Returns list of (entry_id, payload_dict).
    """
    client = get_client()
    if client is None:
        return []
    try:
        res = await client.xread({stream: last_id}, count=count, block=block_ms)
        if not res:
            return []
        entries: list[tuple[str, dict[str, Any]]] = []
        for _stream_name, stream_entries in res:
            for entry_id, fields in stream_entries:
                decoded: dict[str, Any] = {}
                for k, v in fields.items():
                    try:
                        decoded[k] = json.loads(v)
                    except (ValueError, TypeError):
                        decoded[k] = v
                entries.append((str(entry_id), decoded))
        return entries
    except Exception as exc:
        log.warning("redis_bus: xread from %s failed: %s", stream, exc)
        return []


async def xgroup_create(stream: str, group: str, start_id: str = "0", mkstream: bool = True) -> bool:
    """
    Create a consumer group on a Redis stream.
    Idempotent: ignores BUSYGROUP errors if the group already exists.
    """
    client = get_client()
    if client is None:
        return False
    try:
        await client.xgroup_create(name=stream, groupname=group, id=start_id, mkstream=mkstream)
        log.info("redis_bus: created consumer group '%s' on stream '%s'", group, stream)
        return True
    except Exception as exc:
        if "BUSYGROUP" in str(exc):
            return True  # Already exists, perfectly fine
        log.warning("redis_bus: xgroup_create failed for stream %s, group %s: %s", stream, group, exc)
        return False


async def xreadgroup(
    group: str,
    consumer: str,
    stream: str,
    count: int = 10,
    block_ms: int = 1000,
) -> list[tuple[str, dict[str, Any]]]:
    """
    Read incoming unacknowledged messages for a consumer in a group using ID '>'.
    Returns list of (entry_id, payload_dict).
    """
    client = get_client()
    if client is None:
        return []
    try:
        res = await client.xreadgroup(
            groupname=group,
            consumername=consumer,
            streams={stream: ">"},
            count=count,
            block=block_ms,
        )
        if not res:
            return []
        entries: list[tuple[str, dict[str, Any]]] = []
        for _stream_name, stream_entries in res:
            for entry_id, fields in stream_entries:
                decoded: dict[str, Any] = {}
                for k, v in fields.items():
                    try:
                        decoded[k] = json.loads(v)
                    except (ValueError, TypeError):
                        decoded[k] = v
                entries.append((str(entry_id), decoded))
        return entries
    except Exception as exc:
        log.warning("redis_bus: xreadgroup on %s failed: %s", stream, exc)
        return []


async def xautoclaim(
    stream: str,
    group: str,
    consumer: str,
    min_idle_ms: int = 30_000,
    count: int = 50,
) -> list[tuple[str, dict[str, Any]]]:
    """
    Reclaim entries that have sat unacknowledged in another consumer's
    Pending Entries List for at least `min_idle_ms` — the entry any consumer
    read via `xreadgroup` but then crashed, was killed, or restarted (with a
    new consumer name — see `worker.py`'s `consumer_name` comment) before
    calling `xack`. Without this, those entries are stuck in the PEL forever
    with nothing anywhere in this codebase to reclaim them.

    Returns the reclaimed entries in the same `(entry_id, payload_dict)`
    shape as `xread`/`xreadgroup`, ready to reprocess — the caller is
    responsible for `xack`-ing them again once done.
    """
    client = get_client()
    if client is None:
        return []
    try:
        result = await client.xautoclaim(
            name=stream, groupname=group, consumername=consumer,
            min_idle_time=min_idle_ms, start_id="0-0", count=count,
        )
        # redis-py returns (next_start_id, claimed_entries, deleted_ids);
        # older server/client combinations may return just the pair.
        claimed = result[1] if isinstance(result, (tuple, list)) and len(result) >= 2 else []
        entries: list[tuple[str, dict[str, Any]]] = []
        for entry_id, fields in claimed:
            decoded: dict[str, Any] = {}
            for k, v in fields.items():
                try:
                    decoded[k] = json.loads(v)
                except (ValueError, TypeError):
                    decoded[k] = v
            entries.append((str(entry_id), decoded))
        return entries
    except Exception as exc:
        log.warning("redis_bus: xautoclaim on %s failed: %s", stream, exc)
        return []


async def xack(stream: str, group: str, *entry_ids: str) -> int:
    """
    Acknowledge one or more processed message IDs in a consumer group.
    Returns count of acknowledged messages.
    """
    client = get_client()
    if client is None or not entry_ids:
        return 0
    try:
        return int(await client.xack(stream, group, *entry_ids))
    except Exception as exc:
        log.warning("redis_bus: xack on %s failed: %s", stream, exc)
        return 0


@asynccontextmanager
async def lock(name: str, timeout_seconds: int = 10) -> AsyncIterator[bool]:
    """
    Distributed lock helper using SET NX PX.
    Yields True if acquired, False otherwise.
    """
    client = get_client()
    if client is None:
        yield True  # Fallback to local execution
        return

    lock_key = f"echosphere:lock:{name}"
    val = f"locked-{asyncio.current_task().get_name() if asyncio.current_task() else 'default'}"
    acquired = False
    try:
        acquired = bool(await client.set(lock_key, val, nx=True, ex=timeout_seconds))
        yield acquired
    finally:
        if acquired and client is not None:
            try:
                # Release only if still holding
                curr = await client.get(lock_key)
                if curr == val:
                    await client.delete(lock_key)
            except Exception:
                pass


async def status() -> dict[str, Any]:
    return {
        "enabled": _enabled,
        "connected": _redis is not None,
        "error": _last_error,
    }

