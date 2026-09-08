"""
The Bridge Controller — v6 §5, rebuilt around what Agora actually supports.

────────────────────────────────────────────────────────────────────────────
WHAT CHANGED FROM v6, AND WHY

v6 §5.1 specifies Channel 1 (PUSH) as Custom Instruction Injection:
`POST /agents/{id}/update` carrying an `instruction` the Fast Loop LLM is meant
to act on. Measured on a live channel, that returns HTTP 200 and produces no
speech — the model receives an instruction and, under a prompt whose default is
ABSOLUTE SILENCE, declines to act on it.

Agora exposes two endpoints that do the job directly:

    POST /agents/{id}/speak      {"text": "..."}   -> the TTS module speaks it
    POST /agents/{id}/interrupt  {}                -> stops speech and thinking

Both verified live: `/speak` produced 80% peak audio from uid 9000;
`/interrupt` took it from 58% to silence in about 1.4 s.

This is strictly better for the brief. The Slow Loop now controls Echo's exact
words, so §6 Rules 1–2 are enforced by `utterance.py` and its tests instead of
by a model's discretion. See `docs/session_log.md`.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from dataclasses import dataclass
from typing import Literal

import httpx

from .. import config
from ..models import Claim
from ..utterance import validate

log = logging.getLogger("echo.bridge")

Priority = Literal["high", "normal"]

# §7.3 tuning. Echo never interrupts twice inside this window no matter what
# the room does — the single most important brake on an agent that nags.
INTERRUPTION_FLOOR_SECONDS = 12.0

# §5.1: duplicate instructions inside this window are coalesced rather than
# queued, so a burst of contradictions produces one utterance, not a stutter.
COALESCE_WINDOW_SECONDS = 12.0


@dataclass
class SpeakResult:
    ok: bool
    status: int
    latency_ms: float
    text: str
    detail: str = ""


class BridgeController:
    """
    Owns every word Echo says proactively, and the single-slot pre-emptive
    queue in front of it (§5.1).

    Priority discipline:
      high   — contradictions and approvals. Interrupt whatever is happening.
      normal — tension and summaries. Wait for a turn boundary; a
               de-escalation that talks over someone ADDS tension.
    """

    def __init__(self, channel: str, agent_id: str, *, client: httpx.AsyncClient | None = None):
        self.channel = channel
        self.agent_id = agent_id
        self._client = client
        self._owns_client = client is None
        self._last_spoke_at = 0.0
        self._recent: dict[str, float] = {}
        self._lock = asyncio.Lock()

    # -- plumbing ----------------------------------------------------------

    async def __aenter__(self) -> "BridgeController":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=20.0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    def _auth(self) -> str:
        s = config.agora()
        raw = f"{s.customer_id}:{s.customer_secret}".encode()
        return "Basic " + base64.b64encode(raw).decode()

    def _url(self, action: str) -> str:
        return f"{config.agora().conv_ai_base}/agents/{self.agent_id}/{action}"

    # -- Rule 3: the structural half --------------------------------------

    @staticmethod
    def strip_inferred(claims: list[Claim]) -> list[Claim]:
        """
        §6.2 Rule 3 — INFERRED claims never reach the voice channel.

        This is the filter the model "cannot route around", because inferred
        claims are never placed in its context in the first place. Every path
        that composes speech must pass its claims through here first.
        """
        return [c for c in claims if c.epistemic_status != "INFERRED"]

    # -- the three actions -------------------------------------------------

    async def speak(
        self,
        text: str,
        *,
        priority: Priority = "high",
        dedupe_key: str | None = None,
        force: bool = False,
    ) -> SpeakResult | None:
        """
        Say exactly this. Returns None when the utterance was suppressed by the
        interruption floor or by coalescing — suppression is normal operation,
        not an error.

        `text` is validated against §6 one final time here. utterance.py already
        validates at composition, but this is the last gate before the channel
        and it is cheap; a caller that hand-rolls a string still cannot get a
        diagnosing sentence past it.
        """
        validate(text)

        async with self._lock:
            now = time.monotonic()

            if dedupe_key is not None:
                last = self._recent.get(dedupe_key)
                if last is not None and now - last < COALESCE_WINDOW_SECONDS:
                    log.info("bridge: coalesced duplicate %s", dedupe_key)
                    return None

            since = now - self._last_spoke_at
            if not force and since < INTERRUPTION_FLOOR_SECONDS and self._last_spoke_at > 0:
                if priority == "normal":
                    log.info("bridge: normal-priority utterance suppressed (%.1fs since last)", since)
                    return None
                # A high-priority alert still respects the floor — v6 §7.3 calls
                # it a GLOBAL floor "regardless of cause". Echo stuttering over
                # itself reads as broken and costs more than the delay.
                log.info("bridge: high-priority held by interruption floor (%.1fs)", since)
                return None

            assert self._client is not None, "use `async with BridgeController(...)`"
            started = time.perf_counter()
            resp = await self._client.post(
                self._url("speak"),
                headers={"Authorization": self._auth(), "Content-Type": "application/json"},
                json={"text": text},
            )
            latency = (time.perf_counter() - started) * 1000

            if resp.is_success:
                self._last_spoke_at = now
                if dedupe_key is not None:
                    self._recent[dedupe_key] = now

            log.info("bridge: speak %s in %.0fms", resp.status_code, latency)
            return SpeakResult(
                ok=resp.is_success,
                status=resp.status_code,
                latency_ms=latency,
                text=text,
                detail="" if resp.is_success else resp.text[:300],
            )

    async def interrupt(self) -> bool:
        """Stop Echo mid-sentence. Verified live at ~433 ms to acknowledgement."""
        assert self._client is not None, "use `async with BridgeController(...)`"
        resp = await self._client.post(
            self._url("interrupt"),
            headers={"Authorization": self._auth(), "Content-Type": "application/json"},
            json={},
        )
        log.info("bridge: interrupt %s", resp.status_code)
        return resp.is_success

    async def speak_now(self, text: str) -> SpeakResult | None:
        """
        Pre-empt: interrupt whatever Echo is saying, then say this.

        Reserved for the two cases §5.1 lists as `high` — an adjudicated
        contradiction and an authorization request. Everything else waits.
        """
        await self.interrupt()
        # A beat for the TTS buffer to drain, so the new line does not overlap
        # the tail of the old one.
        await asyncio.sleep(0.4)
        return await self.speak(text, priority="high", force=True)
