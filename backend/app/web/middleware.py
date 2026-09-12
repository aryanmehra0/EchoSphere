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

────────────────────────────────────────────────────────────────────────────
WHY `is_local()` DOES NOT LOOK AT THE `Host` HEADER

It used to. `Host` is picked entirely by whoever sends the request — it is
not tied to the TCP connection in any way — and this project's tunnel
(`start.ps1` runs `cloudflared tunnel --url http://localhost:8000`, a Quick
Tunnel with no `originRequest` override) forwards a client's Host header to
this origin unmodified by default. A remote attacker hitting the public
`*.trycloudflare.com` hostname could therefore set `Host: localhost` and skip
every check below outright — confirmed against cloudflared's documented
default behaviour, not assumed.

`request.client.host` alone does not fix this either: cloudflared dials this
origin over loopback, so a request that arrived through the tunnel and one
that arrived from a process on this machine calling `:8000` directly are
BOTH seen as coming from 127.0.0.1 at the TCP layer.

The signal that actually distinguishes them is Cloudflare's own edge: every
request that transits Cloudflare's network — which is the only way a remote
party reaches this process at all, since it listens on loopback and
cloudflared is the sole ingress — arrives carrying `cf-ray` (and usually
`cf-connecting-ip`), stamped on by Cloudflare's infrastructure AFTER it
receives the request. A caller cannot suppress a header added downstream of
their own request. This is trustworthy specifically BECAUSE this process has
no other route in from the internet; an origin that were also independently
publicly reachable could have these headers forged by hitting it directly,
which does not apply here.

So: local means "no Cloudflare-tunnel fingerprint present", not "claims to be
local". Genuinely local callers (the dashboard via the Next.js proxy, the
Rehearsal Rig, demo scripts) never carry these headers; anything that
actually came through the tunnel always does.
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


def _is_rate_limited_memory(ip: str, limit: int = 50, window: float = 1.0) -> bool:
    now = time.time()
    timestamps = [t for t in _RATE_LIMITS.get(ip, ()) if now - t < window]
    if len(timestamps) >= limit:
        _RATE_LIMITS[ip] = timestamps
        return True
    timestamps.append(now)
    _RATE_LIMITS[ip] = timestamps
    return False


def _sweep_rate_limits(window: float = 1.0) -> int:
    """
    Drop every IP whose window has gone quiet.

    `_is_rate_limited_memory` only ever prunes an IP's OWN list, and only when
    that IP makes another request — one that stops calling forever leaves its
    (now-empty, but still allocated) entry in `_RATE_LIMITS` for the life of
    the process. Called periodically from `main.py`'s maintenance ticker so a
    long-running process with many distinct callers doesn't grow this dict
    without bound.
    """
    now = time.time()
    stale = [ip for ip, timestamps in _RATE_LIMITS.items() if not any(now - t < window for t in timestamps)]
    for ip in stale:
        del _RATE_LIMITS[ip]
    return len(stale)


async def _is_rate_limited(ip: str, limit: int = 50, window: float = 1.0) -> bool:
    """Distributed sliding-window rate limiter in Redis with in-memory fallback."""
    from app.infrastructure import redis_bus
    client = redis_bus.get_client()
    if client is not None:
        try:
            key = f"echosphere:ratelimit:{ip}"
            now = time.time()
            clear_before = now - window
            pipe = client.pipeline()
            pipe.zremrangebyscore(key, 0, clear_before)
            pipe.zadd(key, {str(now): now})
            pipe.zcard(key)
            pipe.expire(key, int(window) + 2)
            res = await pipe.execute()
            count = res[2]
            return count > limit
        except Exception:
            pass

    return _is_rate_limited_memory(ip, limit=limit, window=window)


async def verify_hmac(request: Request, secret: str) -> bool:
    """
    Verify HMAC-SHA256 signature with 300s timestamp freshness check.

    The signed message includes a hash of the request BODY, not just
    timestamp/method/path. Without it, a signature captured from one request
    verified for ANY body sent within the 300s window — an attacker who
    observed one valid signed call to `/tools/invoke` could replay it with a
    completely different `action`/`args` and it would still pass. Reading the
    body here does not consume it for the actual handler: Starlette caches
    `request.body()`'s result the first time it's awaited, so downstream
    `request.json()` still sees the full body.
    """
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

    body = await request.body()
    body_hash = hashlib.sha256(body).hexdigest()
    msg = f"{ts}.{request.method}.{request.url.path}.{body_hash}"
    expected = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


# Health is the one thing a tunnel may answer unauthenticated: it reports
# presence, never values, and being able to check "is the tunnel live?"
# without a token is worth more than hiding it.
_PUBLIC_PATHS = ("/health", "/")

# ── THE ONE PATH EXEMPT FOR A REASON OTHER THAN BEING LOCAL ────────────────
#
# `/observer/transcript`, `/observer/acoustic_telemetry`, `/telemetry/probe`,
# `/projects/*` and `/incident/postmortem|archives|search` used to be exempt
# here too, on the theory that they're "the console's own browser paths".
# They are also exactly the paths that ACCEPT DATA — a transcript, a
# telemetry reading, evidence — and a remote caller with no secret could
# freely inject fabricated evidence into a live incident's record through
# them. Closing that requires them to need the secret like everything else;
# `frontend/middleware.ts` now attaches it to every one of these when the
# browser calls them through the Next.js proxy, so the console keeps working
# unchanged (see that file for how).
#
# `/ws/deltas` stays exempt: it is a read-only delta stream (HELLO/SNAPSHOT/
# REPLAY, never a write), a plain browser `WebSocket()` cannot attach a
# custom header to its handshake at all, and this project's own tunnel setup
# deliberately serves a shared demo link to guests over it.
_BROWSER_PATHS = ("/ws/deltas",)
_BROWSER_PREFIXES = ("/ws/deltas",)


def is_browser_path(path: str) -> bool:
    if path in _BROWSER_PATHS:
        return True
    return any(path == p or path.startswith(p + "/") or path.startswith(p + "?") for p in _BROWSER_PREFIXES)


# Headers Cloudflare's own edge stamps onto every request that transits its
# network, unconditionally — see the module docstring for why presence of
# any one of these, not the (client-controlled) Host header, is what actually
# marks a request as having arrived through the tunnel rather than directly.
_CLOUDFLARE_HEADERS = ("cf-ray", "cf-connecting-ip", "cf-visitor")

# "testclient" is what Starlette's TestClient reports as request.client.host
# (its ASGI scope's peer is the literal tuple ("testclient", 50000)) — the
# test suite's equivalent of loopback.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "testclient"})


def is_local(request: Request) -> bool:
    client_host = (request.client.host if request.client else "") or ""
    if client_host.lower() not in _LOOPBACK_HOSTS:
        return False
    return not any(request.headers.get(h) for h in _CLOUDFLARE_HEADERS)


def register(app: FastAPI) -> None:
    """Attach the gate. Called once by the app factory."""

    @app.middleware("http")
    async def tunnel_gate(request: Request, call_next):  # type: ignore[no-untyped-def]
        host = request.headers.get("host", "")
        if is_local(request):
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

        # Rate limiting per REAL client IP. `request.client.host` is the
        # tunnel daemon's own loopback connection for every remote request —
        # using it here would put all internet traffic in one shared bucket.
        # `cf-connecting-ip` is the address Cloudflare's edge observed, and is
        # trustworthy for the same reason `is_local()` trusts its presence at
        # all: this process has no ingress route that bypasses Cloudflare.
        client_ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else host)
        if await _is_rate_limited(client_ip):
            log.warning("middleware: rate limit exceeded for %s", client_ip)
            return JSONResponse({"error": "Too many requests"}, status_code=429)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        # OPTIONS preflight for CORS
        if request.method == "OPTIONS":
            return await call_next(request)

        if is_browser_path(request.url.path):
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
        has_valid_hmac = await verify_hmac(request, secret)

        if not (has_valid_token or has_valid_hmac):
            log.warning(
                "refused remote %s %s — bad or missing tool token/signature",
                request.method, host,
            )
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

        return await call_next(request)
