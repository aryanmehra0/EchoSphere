"""
Loki HTTP API Adapter.

Same role as `prometheus_client.py` but for log lines rather than metrics —
queries the local Loki server (see `docker-compose.yml`'s `loki` +
`telemetry-sim` services) for real log entries instead of a hardcoded string.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from app.infrastructure import config

log = logging.getLogger("echo.loki_client")

_client: httpx.AsyncClient | None = None
_enabled: bool = False
_last_error: str | None = None


def is_enabled() -> bool:
    return _enabled


async def connect() -> bool:
    """Verify the configured Loki server actually answers. Never raises."""
    global _client, _enabled, _last_error

    url = config.loki_url()
    if not url:
        _enabled = False
        return False

    client = httpx.AsyncClient(base_url=url, timeout=4.0)
    try:
        resp = await client.get("/ready")
        if resp.status_code != 200:
            raise RuntimeError(f"not ready: HTTP {resp.status_code}")
        _client = client
        _enabled = True
        _last_error = None
        log.info("loki_client: connected to %s", url)
        return True
    except Exception as exc:
        _last_error = str(exc)
        _enabled = False
        await client.aclose()
        _client = None
        log.warning("loki_client: %s unavailable (%s); telemetry probes will use the static fallback", url, exc)
        return False


async def disconnect() -> None:
    global _client, _enabled
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:
            pass
        _client = None
    _enabled = False


async def query_range(logql: str, *, minutes: int = 30, limit: int = 5) -> list[str] | None:
    """
    Run a LogQL range query over the last `minutes` and return the matching
    log lines (most recent first), or `None` when Loki is unreachable or the
    query errors. An empty list (not `None`) means Loki answered but nothing
    matched — a real, meaningful result, distinct from "couldn't ask".
    """
    global _enabled, _last_error

    if not _enabled or _client is None:
        return None

    now_ns = int(time.time() * 1e9)
    start_ns = now_ns - minutes * 60 * 1_000_000_000

    try:
        resp = await _client.get(
            "/loki/api/v1/query_range",
            params={
                "query": logql,
                "start": str(start_ns),
                "end": str(now_ns),
                "limit": limit,
                "direction": "backward",
            },
        )
        resp.raise_for_status()
        body: dict[str, Any] = resp.json()
    except Exception as exc:
        _last_error = str(exc)
        _enabled = False
        log.warning("loki_client: query failed (%s); marking disconnected until next reconnect attempt", exc)
        return None

    if body.get("status") != "success":
        return None

    lines: list[str] = []
    for stream in body.get("data", {}).get("result", []):
        for _ts, line in stream.get("values", []):
            lines.append(line)
    return lines[:limit]


def status() -> dict[str, Any]:
    return {
        "enabled": _enabled,
        "url": config.loki_url(),
        "error": _last_error,
    }
