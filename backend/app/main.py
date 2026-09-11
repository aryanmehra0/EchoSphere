"""
Zone 3 — the Slow Loop service.

The app factory and nothing else: lifespan, CORS, the tunnel gate, and the
routers. Every handler lives in `routers/`, every piece of orchestration in
`services/`, every outbound call in `adapters/`.

    routers/     transport — read the body, call a service, shape the response
    services/    orchestration — the pipeline, the session, speech, budget
    adapters/    the network boundary — Agora and Groq
    middleware   the tunnel auth gate

Nothing here speaks unless `utterance.py` composed the sentence and
`services/speech.py` let it through.

Run:  .venv/Scripts/uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.application.services import pipeline
from app.application.services.session import registry
from app.infrastructure import config, store
from app.web import middleware
from app.web.deps import set_http_client, speech
from app.web.routers import agent, approval, audio_stream, bridge, deltas, ingest, ops, tools

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(name)-14s %(message)s")
log = logging.getLogger("echo.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = httpx.AsyncClient(timeout=20.0)
    set_http_client(client)

    # The silence-based flush needs a ticker: the 1.5 s rule fires when someone
    # STOPS talking, and no incoming frame will arrive to trigger it. Without
    # this, the last sentence before a pause sits in the window unextracted —
    # which on a bridge is precisely the sentence people are waiting on.
    async def flush_ticker() -> None:

        while True:
            await asyncio.sleep(0.5)
            try:
                current = registry.current()
                await pipeline.run_if_ready(current, speech(current))
            except Exception:  # noqa: BLE001 — a bad window must not kill the loop
                log.exception("flush ticker failed")

    # ── DURABILITY, AND WHY IT IS OPTIONAL ──────────────────────────────
    # `connect` never raises: a machine with no Docker must still run the
    # bridge, degrading to the in-memory Ledger it has always used. Whether
    # persistence is actually on is reported by /health rather than assumed.
    if await store.connect():
        try:
            restored = await registry.current().ledger.restore()
            if restored:
                log.info("Ledger restored from Postgres: %d rows", restored)
        except Exception:
            log.exception("could not restore the Ledger — continuing empty")

    ticker = asyncio.create_task(flush_ticker())
    log.info("Slow Loop up. observer mode=%s", config.observer_mode())

    yield

    ticker.cancel()
    await store.close()
    await client.aclose()
    set_http_client(None)


app = FastAPI(title="EchoSphere — Slow Loop", version="0.1.0", lifespan=lifespan)

# ── WHICH ORIGINS MAY REACH THE SLOW LOOP DIRECTLY ─────────────────────────
#
# The console now PROXIES this service at its own origin (`next.config.ts`
# rewrites /observer/*, /ws/deltas, /health and the rest to :8000), so the
# browser's requests are same-origin and never preflight. That is the fix for
# the reported "TRANSCRIPT FORWARDING PAUSED: SLOW LOOP RETURNED HTTP 404",
# and it also means CORS is no longer on the critical path for the dashboard.
#
# This list still matters for everything that calls :8000 DIRECTLY - the demo
# scripts, the rehearsal rig, a curl during diagnosis - and for a console
# deliberately pointed at an absolute NEXT_PUBLIC_SLOW_LOOP_WS.
#
# `start.ps1` no longer uses :3000 at all: it is the default port of every
# Node dev server on a machine, and losing the race to one silently published
# somebody else's app through the share tunnel. The console starts at :3100
# and walks 3200/3300/3400/3500, so those are listed. 3000/3001 stay for a
# console started by hand with a plain `npm run dev`.
_cors_origins = [
    *[
        f"http://{host}:{port}"
        for port in (3000, 3001, 3100, 3200, 3300, 3400, 3500)
        for host in ("localhost", "127.0.0.1")
    ],
    *[o.strip() for o in config.cors_origins().split(",") if o.strip()],
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

middleware.register(app)

# Order is presentational only — FastAPI matches on path, not registration.
# Grouped as: what comes in, what Agora calls, what we drive, what we govern.
app.include_router(ingest.router)
app.include_router(audio_stream.router)
app.include_router(tools.router)
app.include_router(agent.router)
app.include_router(bridge.router)
app.include_router(approval.router)
app.include_router(ops.router)
app.include_router(deltas.router)
