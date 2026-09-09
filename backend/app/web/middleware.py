"""
The tunnel gate — v6 §10.1.

────────────────────────────────────────────────────────────────────────────
Agora's Engine calls our REST tools from its own servers, so the Slow Loop
must be publicly reachable for `query_incident_state` to work. A tunnel does
that — and in doing so exposes `/incident/reset`, `/bridge/say` and
`/approval/redeem` to anyone who learns the hostname.

So anything arriving on a non-local Host must present AGENT_TOOL_SECRET.
Local traffic is untouched: the dashboard, the demo script and all three
Rehearsal Rig tiers behave exactly as they did before this existed.

Fail-closed on purpose. If the tunnel is up and the secret is NOT set, every
remote request is refused rather than served — the alternative is a public,
unauthenticated control surface that looks like it is working.
"""

import hashlib
import hmac
import logging
import secrets
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.infrastructure import config

log = logging.getLogger("echo.middleware")

MAX_PAYLOAD_BYTES = 65536  # 64KB
_RATE_LIMITS: dict[str, list[float]] = {}


def _is_rate_limited(ip: str, limit: int = 50, window: float = 1.0) -> bool:
    now = time.time()
    timestamps = _RATE_LIMITS.setdefault(ip, [])
    _RATE_LIMITS[ip] = [t for t in timestamps if now - t < window]
    if len(_RATE_LIMITS[ip]) >= limit:
        return True
    _RATE_LIMITS[ip].append(now)
    return False


def verify_hmac(request: Request, secret: str) -> bool:
    """Verify HMAC-SHA256 signature with 300s timestamp freshness check."""
    sig = request.headers.get("x-echo-signature", "").strip()
    ts_str = request.headers.get("x-echo-timestamp", "").strip()
    if not sig or not ts_str:
        return False
    try:
        ts = int(ts_str)
    except ValueError:
        return False

    now_s = int(time.time())
    if abs(now_s - ts) > 300:
        log.warning("middleware: rejected expired webhook timestamp: %d (now: %d)", ts, now_s)
        return False

    msg = f"{ts}.{request.method}.{request.url.path}"
    expected = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


# Health is the one thing a tunnel may answer unauthenticated: it reports
# presence, never values, and being able to check "is the tunnel live?"
# without a token is worth more than hiding it.
_PUBLIC_PATHS = ("/health", "/")

# ── THE CONSOLE'S OWN BROWSER & OBSERVER PATHS ────────────────────────────
_BROWSER_PATHS = ("/observer/transcript", "/observer/acoustic_telemetry", "/ws/deltas")


def is_local(host: str) -> bool:
    h = host.strip()
    if h.startswith("["):
        h = h.split("]")[0].lstrip("[")
    else:
        h = h.split(":")[0]
    return h.lower() in ("127.0.0.1", "localhost", "::1", "testserver")


def register(app: FastAPI) -> None:
    """Attach the gate. Called once by the app factory."""

    @app.middleware("http")
    async def tunnel_gate(request: Request, call_next):  # type: ignore[no-untyped-def]
        host = request.headers.get("host", "")
        if is_local(host):
            return await call_next(request)

        # Enforce payload size limit on all remote requests
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > MAX_PAYLOAD_BYTES:
                    log.warning("middleware: payload too large: %s bytes", content_length)
                    return JSONResponse({"error": "Payload too large"}, status_code=413)
            except ValueError:
                pass

        # Rate limiting per client IP
        client_ip = request.client.host if request.client else host
        if _is_rate_limited(client_ip):
            log.warning("middleware: rate limit exceeded for %s", client_ip)
            return JSONResponse({"error": "Too many requests"}, status_code=429)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        # OPTIONS preflight for CORS
        if request.method == "OPTIONS":
            return await call_next(request)

        if request.url.path in _BROWSER_PATHS:
            return await call_next(request)

        secret = config.tool_secret()
        if not secret:
            log.warning(
                "refused remote %s %s — AGENT_TOOL_SECRET is not set",
                request.method, host,
            )
            return JSONResponse(
                {"error": "This service is not configured to accept remote requests."},
                status_code=503,
            )

        presented = request.headers.get("x-echo-tool-token", "")
        has_valid_token = secrets.compare_digest(presented, secret) if presented else False
        has_valid_hmac = verify_hmac(request, secret)

        if not (has_valid_token or has_valid_hmac):
            log.warning(
                "refused remote %s %s — bad or missing tool token/signature",
                request.method, host,
            )
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

        return await call_next(request)
