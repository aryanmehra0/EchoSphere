"""
The Delta Hub — v6 §9.2 / §9.3, closing G6.

v5's dashboard socket was delta-only and additive, with no sequence number and
no snapshot on connect. A refresh, a laptop sleep, or a two-second Wi-Fi drop
at 2:10 into a 3:00 demo left the graph permanently empty.

Every message here carries a monotonic `seq`. A connecting client sends HELLO
with its `lastSeq`; the hub replies with a REPLAY if the gap is inside the ring
buffer, or a full SNAPSHOT if it is not. The frontend reducer merges by id and
is idempotent, which is what lets the hub choose freely without the client
reconciling anything.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from typing import Any

log = logging.getLogger("echo.deltas")

# §9.3 specifies 500. Large enough that a normal reconnect always replays, small
# enough that a long incident cannot grow it without bound.
RING_SIZE = 500


class DeltaHub:
    """Sequenced fan-out to every connected dashboard."""

    def __init__(self) -> None:
        self._seq = 0
        self._ring: deque[dict[str, Any]] = deque(maxlen=RING_SIZE)
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()

    @property
    def seq(self) -> int:
        return self._seq

    async def publish(self, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Broadcast one delta. Returns the envelope so callers can log the seq.

        Empty payloads are dropped rather than sent: a delta that changes
        nothing still costs a render on every connected client.
        """
        if not payload:
            return {}

        async with self._lock:
            self._seq += 1
            envelope = {
                "seq": self._seq,
                "at": _now_ms(),
                "kind": "DELTA",
                "payload": payload,
            }
            self._ring.append(envelope)

        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for q in self._subscribers:
            try:
                q.put_nowait(envelope)
            except asyncio.QueueFull:
                # A client too slow to keep up gets dropped rather than allowed
                # to back-pressure the analytics pipeline. It will reconnect and
                # receive a SNAPSHOT, which is cheaper than stalling everyone.
                dead.append(q)

        for q in dead:
            self._subscribers.discard(q)
            log.warning("deltas: dropped a slow subscriber")

        return envelope

    async def broadcast(self, message: dict[str, Any]) -> int:
        """
        Send a non-delta message (a SNAPSHOT, say) to every connected client.

        Deliberately does NOT touch `seq` or the ring buffer: this is out-of-band
        control traffic, and giving it a sequence number would make reconnecting
        clients think they had missed a delta.

        Returns how many clients it reached.
        """
        delivered = 0
        for q in list(self._subscribers):
            try:
                q.put_nowait(message)
                delivered += 1
            except asyncio.QueueFull:
                self._subscribers.discard(q)
                log.warning("deltas: dropped a slow subscriber during broadcast")
        return delivered

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(q)

    def since(self, last_seq: int) -> list[dict[str, Any]] | None:
        """
        Deltas after `last_seq`, or None when the gap is too large to replay
        and the caller must send a SNAPSHOT instead.
        """
        if not self._ring:
            return [] if last_seq == self._seq else None

        oldest = self._ring[0]["seq"]
        if last_seq + 1 < oldest:
            return None  # evicted from the ring — snapshot required
        return [e for e in self._ring if e["seq"] > last_seq]

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


def encode(message: dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"))
