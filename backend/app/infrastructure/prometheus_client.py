"""
Prometheus HTTP API Adapter.

Replaces the old hardcoded fixture dict in `app/domain/services/telemetry.py`
with a real query against a real Prometheus server (see
`docker-compose.yml`'s `prometheus` + `telemetry-sim` services). Follows the
same connect/is_enabled/disconnect shape as `vector_store.py` and
`redis_bus.py` so it degrades the same way the rest of this codebase's
optional infrastructure does: unreachable at startup or at any later point
means "not enabled", never a crash.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.infrastructure import config

log = logging.getLogger("echo.prometheus_client")

_client: httpx.AsyncClient | None = None
_enabled: bool = False
_last_error: str | None = None


def is_enabled() -> bool:
    return _enabled


async def connect() -> bool:
    """
    Verify the configured Prometheus server actually answers.

    Never raises — an unreachable Prometheus is a normal, expected state
    (dev laptop with the `telemetry` compose profile not started), not a
    startup failure for the Slow Loop.
    """
    global _client, _enabled, _last_error

    url = config.prometheus_url()
    if not url:
        _enabled = False
        return False

    client = httpx.AsyncClient(base_url=url, timeout=4.0)
    try:
        resp = await client.get("/-/healthy")
        if resp.status_code != 200:
            raise RuntimeError(f"unhealthy: HTTP {resp.status_code}")
        _client = client
        _enabled = True
        _last_error = None
        log.info("prometheus_client: connected to %s", url)
        return True
    except Exception as exc:
        _last_error = str(exc)
        _enabled = False
        await client.aclose()
        _client = None
        log.warning("prometheus_client: %s unavailable (%s); telemetry probes will use the static fallback", url, exc)
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


async def instant_query(promql: str) -> float | None:
    """
    Run a PromQL instant query and return the single resulting scalar, or
    `None` when Prometheus is unreachable, the query errors, or returns no
    series at all (e.g. the metric name doesn't exist yet).
    """
    global _enabled, _last_error

    if not _enabled or _client is None:
        return None

    try:
        resp = await _client.get("/api/v1/query", params={"query": promql})
        resp.raise_for_status()
        body: dict[str, Any] = resp.json()
    except Exception as exc:
        _last_error = str(exc)
        _enabled = False
        log.warning("prometheus_client: query failed (%s); marking disconnected until next reconnect attempt", exc)
        return None

    if body.get("status") != "success":
        return None

    result = body.get("data", {}).get("result", [])
    if not result:
        return None

    # Instant query on a single-series gauge: `result[0]["value"]` is
    # `[unix_timestamp, "string-encoded-float"]` per Prometheus's own API
    # format — the value is a string specifically so large/precise numbers
    # don't lose precision in JSON.
    try:
        return float(result[0]["value"][1])
    except (KeyError, IndexError, TypeError, ValueError):
        return None


def status() -> dict[str, Any]:
    return {
        "enabled": _enabled,
        "url": config.prometheus_url(),
        "error": _last_error,
    }
