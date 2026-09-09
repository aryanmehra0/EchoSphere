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

from __future__ import annotations

import logging
import secrets

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.infrastructure import config

log = logging.getLogger("echo.middleware")

# Health is the one thing a tunnel may answer unauthenticated: it reports
# presence, never values, and being able to check "is the tunnel live?"
# without a token is worth more than hiding it.
_PUBLIC_PATHS = ("/health", "/")

# ── THE CONSOLE'S OWN BROWSER PATHS ────────────────────────────────────────
#
# This gate was written for ONE remote caller: Agora's servers invoking
# /tools/*. Sharing the console over a tunnel added a second, which the gate
# had never seen — the guest's BROWSER, which holds no secret and must never
# be given one (it would be readable by anyone with the link).
#
# These two are what a participating browser needs, and neither is a control
# surface: /observer/transcript ingests speech the sender just spoke aloud on
# the bridge, and /ws/deltas is the same read-only view the dashboard already
# renders.
#
# Everything that CHANGES the world — /incident/reset, /bridge/say,
# /approval/redeem, /tools/* — stays behind the token. That is the line this
# gate exists to hold, and it still holds.
_BROWSER_PATHS = ("/observer/transcript", "/ws/deltas")


def is_local(host: str) -> bool:
    return host.split(":")[0].strip("[]").lower() in ("127.0.0.1", "localhost", "::1")


def register(app: FastAPI) -> None:
    """Attach the gate. Called once by the app factory."""

    @app.middleware("http")
    async def tunnel_gate(request: Request, call_next):  # type: ignore[no-untyped-def]
        host = request.headers.get("host", "")
        if is_local(host):
            return await call_next(request)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)

        # ── CORS PREFLIGHTS CANNOT CARRY THE TOKEN ─────────────────────────
        #
        # A browser sends OPTIONS *before* the real request and is forbidden
        # from attaching custom headers to it, so `x-echo-tool-token` is never
        # present. Refusing it 401 kills the request that follows, and the
        # browser reports only "Failed to fetch" — which surfaced here as
        # "Transcript forwarding paused: Failed to fetch", naming neither CORS
        # nor this gate.
        #
        # Answering the preflight grants nothing: it returns headers, never
        # data, and the POST behind it is still gated below.
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
        if not secrets.compare_digest(presented, secret):
            log.warning(
                "refused remote %s %s — bad or missing tool token",
                request.method, host,
            )
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

        return await call_next(request)
