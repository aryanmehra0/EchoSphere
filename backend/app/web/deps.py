"""
What the routers need in order to do transport work, and nothing more.

Two things live here and they are here for the same reason: both are
process-scoped rather than incident-scoped, and both were previously module
globals in `main.py` that every handler reached into directly.

Keeping them in a module the routers import — rather than importing from
`main` — is what stops the import cycle: `main` imports the routers, so the
routers must not import `main`.
"""

from __future__ import annotations

import httpx

from fastapi import HTTPException

from app.application.services.session import IncidentSession, TooManySessions, registry
from app.application.services.speech import SpeechCoordinator

# ── THE POOLED HTTP CLIENT ─────────────────────────────────────────────────
#
# Owned by the app lifespan, not by an incident: one pooled client should
# outlive any single bridge, and tying its lifetime to `/incident/reset` would
# tear down live connections mid-call.
#
# Held in a one-element dict rather than a bare module name so the lifespan can
# replace it without every importer having captured a stale `None`.
_http: dict[str, httpx.AsyncClient | None] = {"client": None}


def set_http_client(client: httpx.AsyncClient | None) -> None:
    """Called by the app lifespan on startup and shutdown."""
    _http["client"] = client


def http_client() -> httpx.AsyncClient | None:
    return _http["client"]


def session(channel: str | None = None) -> IncidentSession:
    """
    The active incident, resolved per request for a specific channel or the default.

    Resolved per request rather than captured, because `/incident/reset`
    REPLACES the session object — a handler holding a reference across that
    boundary would keep writing to a Ledger nobody is reading.

    Translates `TooManySessions` into a clean 503 here — this is the one
    place every router actually reaches a session through, so it's the
    right (and only) spot that needs to know the registry can refuse.
    """
    try:
        return registry.get_or_create(channel)
    except TooManySessions as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def speech(for_session: IncidentSession | None = None) -> SpeechCoordinator:
    """
    A coordinator bound to the current session and the pooled client.

    Cheap to construct and deliberately not cached: the agent id changes when
    Zone 2 invites a replacement, and caching across that change is how
    `/speak` ended up being issued against an agent that had already left.
    """
    return SpeechCoordinator(for_session or session(), client=http_client())
