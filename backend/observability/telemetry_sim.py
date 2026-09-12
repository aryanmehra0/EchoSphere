"""
Synthetic telemetry generator for the local Prometheus + Loki stack.

── WHY THIS EXISTS ──────────────────────────────────────────────────────────
`TelemetryService` used to hold every metric value as a hardcoded Python dict
(see `app/domain/services/telemetry.py`'s old `_catalog`) — no network call,
no real Prometheus, no real Loki, ever. That made "Echo checks Datadog" a lie
the tool's own description told the LLM.

This script is the other half of making it true: it exposes the SAME
entities and values the fixture dict used to hardcode (Redis at 34.2%
memory, the Postgres replica at 482.5s of replication lag, Checkout's 5xx
spike, etc.) as REAL metrics on a REAL `/metrics` endpoint that a REAL
Prometheus server scrapes — and pushes matching log lines to a REAL Loki.
`TelemetryService.probe()` now queries Prometheus/Loki over HTTP for these
exact values; nothing about the demo incident narrative changes, but the
path to get there is no longer a lie.

Stdlib only — no pip install, no Dockerfile, just `python:3.x-slim` and a
volume mount (see docker-compose.yml's `telemetry-sim` service).
"""

from __future__ import annotations

import http.server
import json
import threading
import time
import urllib.error
import urllib.request

METRICS_PORT = 9105
LOKI_PUSH_URL = "http://loki:3100/loki/api/v1/push"

# entity -> metric -> (value, help text). Mirrors the values that used to be
# hardcoded in `TelemetryService._catalog`, so the existing demo incident
# script still reads the same way once probes are answered for real.
_GAUGES: dict[str, dict[str, tuple[float, str]]] = {
    "redis": {
        "memory_utilization_pct": (34.2, "Redis primary memory utilization percent"),
        "evicted_keys": (0.0, "Redis primary evicted key count, last 60m"),
        "ops_per_sec": (14820.0, "Redis primary throughput, ops/sec"),
    },
    "postgres": {
        "connection_pool_pct": (48.0, "Postgres primary connection pool utilization percent"),
        "replication_lag_seconds": (0.12, "Postgres primary WAL flush lag, seconds"),
    },
    "postgres_replica": {
        "replication_lag_seconds": (482.5, "Postgres replica (us-east-1b) replication lag, seconds"),
        "connection_pool_pct": (89.4, "Postgres replica connection pool utilization percent"),
    },
    "checkout": {
        "p99_latency_ms": (2840.0, "Checkout service p99 latency, milliseconds"),
        "error_rate_5xx_pct": (14.8, "Checkout service HTTP 5xx error rate percent"),
    },
    "auth": {
        "p99_latency_ms": (42.0, "Auth service p99 token validation latency, milliseconds"),
        "error_rate_5xx_pct": (0.02, "Auth service HTTP 5xx error rate percent"),
    },
    "network": {
        "packet_drop_pct": (92.4, "VPC Netpath us-east-1a packet drop rate percent"),
        "rtt_ms": (340.0, "Inter-AZ transit round-trip latency, milliseconds"),
    },
    "stripe": {
        "timeout_rate_pct": (38.5, "Stripe connector gateway timeout rate percent"),
        "connection_pool_pct": (98.0, "Stripe connector outbound connection pool saturation percent"),
    },
    "ingress": {
        "http_5xx_pct": (12.4, "Ingress Gateway upstream 502/504 rate percent"),
    },
}

_LOG_LINES = [
    ("checkout", "error", "5xx spike detected: 621 errors in the last 5m window, p99 2840ms"),
    ("stripe", "error", "circuit breaker OPEN: 142 consecutive gateway timeouts"),
    ("postgres-replica", "warn", "replication lag 482.5s exceeds 5.0s threshold, WAL replay queue 1420"),
    ("network", "error", "packet drop rate 92.4% on eni-08d41a7b, inter-AZ RTT 340ms"),
    ("redis", "info", "memory utilization nominal: 2.7GB / 8.0GB, 0 evictions"),
]


def render_prometheus_text() -> str:
    lines: list[str] = []
    for entity, metrics in _GAUGES.items():
        for metric, (value, help_text) in metrics.items():
            name = f"echo_{entity}_{metric}"
            lines.append(f"# HELP {name} {help_text}")
            lines.append(f"# TYPE {name} gauge")
            lines.append(f"{name} {value}")
    return "\n".join(lines) + "\n"


class _MetricsHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — stdlib's required method name
        if self.path not in ("/metrics", "/"):
            self.send_response(404)
            self.end_headers()
            return
        body = render_prometheus_text().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass  # stdlib's default logs every scrape to stderr; too noisy for a sidecar.


def _push_logs_once() -> None:
    now_ns = str(int(time.time() * 1e9))
    streams = [
        {
            "stream": {"service": service, "level": level},
            "values": [[now_ns, message]],
        }
        for service, level, message in _LOG_LINES
    ]
    payload = json.dumps({"streams": streams}).encode("utf-8")
    req = urllib.request.Request(
        LOKI_PUSH_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, OSError) as exc:
        print(f"telemetry_sim: Loki push failed (will retry): {exc}", flush=True)


def _log_push_loop() -> None:
    # Loki takes a few seconds to become ready after container start; retrying
    # on a loop rather than once means the first push doesn't have to race it.
    while True:
        _push_logs_once()
        time.sleep(30)


def main() -> None:
    threading.Thread(target=_log_push_loop, daemon=True).start()
    server = http.server.ThreadingHTTPServer(("0.0.0.0", METRICS_PORT), _MetricsHandler)
    print(f"telemetry_sim: serving synthetic metrics on :{METRICS_PORT}/metrics", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
