"""
The dashboard socket — v6 §9.3, closes G6.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.infrastructure.deltas import encode
from ..deps import session

log = logging.getLogger("echo.ws")

router = APIRouter()


@router.websocket("/ws/deltas")
async def deltas_socket(ws: WebSocket) -> None:
    """
    HELLO / SNAPSHOT / REPLAY.

    The client sends `{"kind":"HELLO","lastSeq":n|null}`. A fresh client gets a
    SNAPSHOT; a reconnecting one gets a REPLAY when its gap is still in the ring
    buffer, and a SNAPSHOT when it is not. The reducer merges by id and is
    idempotent, so replayed deltas are always safe to reapply.
    """
    # Resolved once, for the handshake only. The QUEUE is what carries deltas
    # after that, and `DeltaHub.adopt` moves it across an `/incident/reset` —
    # so this handler keeps working without holding a session reference that
    # the reset would make stale.
    current = session()
    hub = current.hub

    await ws.accept()
    queue = hub.subscribe()

    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10.0)
        last_seq = hello.get("lastSeq")
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        last_seq = None

    if last_seq is None:
        await ws.send_text(encode({
            "kind": "SNAPSHOT", "seq": hub.seq, "state": current.ledger.snapshot(),
        }))
    else:
        replay = hub.since(int(last_seq))
        if replay is None:
            await ws.send_text(encode({
                "kind": "SNAPSHOT", "seq": hub.seq, "state": current.ledger.snapshot(),
            }))
        else:
            for envelope in replay:
                await ws.send_text(encode({**envelope, "kind": "REPLAY"}))

    try:
        while True:
            envelope = await queue.get()
            await ws.send_text(encode(envelope))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        # Unsubscribe from whichever hub currently owns this queue. After a
        # reset that is the NEW session's hub, not the one we subscribed to,
        # so discarding from the current session is what actually removes it.
        hub.unsubscribe(queue)
        session().hub.unsubscribe(queue)
