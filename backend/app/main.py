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

# The dashboard is served from :3000 in development, but the console may run on
# any port (e.g. :3001 when something else owns 3000). CORS_ORIGINS lets a host
# override the dev defaults without editing source; the browser must be allowed
# to POST /observer/transcript or the voice path dies silently.
_cors_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
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
