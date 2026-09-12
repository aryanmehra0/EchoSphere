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
from app.web.routers import agent, approval, audio_stream, bridge, deltas, ingest, ops, projects, telemetry, tools

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
    #
    # Iterates every active channel, not just the default one — `registry`
    # genuinely supports concurrent incidents (exercised by
    # test_multi_channel.py), but this ticker used to call only
    # `registry.current()`, so a secondary channel's silence-flush never
    # fired at all: the last sentence before a pause on that channel could
    # sit in its window until another transcript happened to arrive later.
    async def flush_ticker() -> None:

        while True:
            await asyncio.sleep(0.5)
            channels = registry.list_channels() or [registry.current().channel]
            for channel in channels:
                try:
                    current = registry.get_or_create(channel)
                    await pipeline.run_if_ready(current, speech(current))
                except Exception:  # noqa: BLE001 — a bad window must not kill the loop
                    log.exception("flush ticker failed for channel %s", channel)

    # Slower-cadence upkeep that doesn't need the 0.5s cadence above:
    # retrying a Redis/Qdrant connection that wasn't ready at startup,
    # sweeping the rate limiter's in-memory IP table, and expiring stale
    # approvals for every live session.
    async def maintenance_ticker() -> None:
        from app.infrastructure import loki_client, prometheus_client, redis_bus, vector_store
        from app.web.middleware import _sweep_rate_limits

        while True:
            await asyncio.sleep(15.0)
            try:
                if not redis_bus.is_enabled():
                    await redis_bus.connect()
                if not vector_store.is_enabled():
                    await vector_store.connect()
                # Also runs when Qdrant was already connected — cheap no-op
                # in that case (nothing in `_in_memory_historical` to move),
                # and it's what actually recovers a postmortem indexed
                # in-memory during a PAST outage that has since resolved.
                await vector_store.backfill_historical()
            except Exception:
                log.exception("maintenance ticker: redis/qdrant reconnect attempt failed")
            try:
                # Same "retry until it answers" treatment as Redis/Qdrant
                # above — neither is required for the Slow Loop to run, and
                # `telemetry.py` already falls back to its static catalog
                # when these are unreachable.
                if not prometheus_client.is_enabled():
                    await prometheus_client.connect()
                if not loki_client.is_enabled():
                    await loki_client.connect()
            except Exception:
                log.exception("maintenance ticker: prometheus/loki reconnect attempt failed")
            try:
                _sweep_rate_limits()
            except Exception:
                log.exception("maintenance ticker: rate limit sweep failed")
            try:
                for channel in registry.list_channels():
                    registry.get_or_create(channel).proxy.gate.expire_stale()
            except Exception:
                log.exception("maintenance ticker: approval expiry sweep failed")

    # ── DURABILITY, AND WHY IT IS OPTIONAL ──────────────────────────────
    # Connect dual-tier storage, Redis event bus, and Qdrant vector store
    if await store.connect():
        try:
            restored = await registry.current().ledger.restore()
            if restored:
                log.info("Ledger restored from Postgres: %d rows", restored)
        except Exception:
            log.exception("could not restore the Ledger — continuing empty")

    from app.infrastructure import loki_client, prometheus_client, redis_bus, vector_store
    await redis_bus.connect()
    await vector_store.connect()
    await prometheus_client.connect()
    await loki_client.connect()

    from app.application.services.worker import extraction_worker
    await extraction_worker.start()

    ticker = asyncio.create_task(flush_ticker())
    upkeep = asyncio.create_task(maintenance_ticker())
    log.info("Slow Loop up. observer mode=%s", config.observer_mode())

    yield

    for task in (ticker, upkeep):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await extraction_worker.stop()
    await vector_store.disconnect()
    await redis_bus.disconnect()
    await prometheus_client.disconnect()
    await loki_client.disconnect()
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
app.include_router(telemetry.router)
app.include_router(projects.router)
app.include_router(agent.router)
app.include_router(bridge.router)
app.include_router(approval.router)
app.include_router(ops.router)
app.include_router(deltas.router)
