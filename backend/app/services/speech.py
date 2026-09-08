"""
The one path from a composed sentence to audio in the room.

────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

Five separate places in `main.py` each did the same four-step dance:

    build a BridgeController for the registered agent
    `async with` it
    call speak() or speak_now()
    maybe set the voice degradation flag, maybe publish the banner

Only ONE of them did the last step. The pipeline's contradiction path
recorded the degradation edge; `/bridge/say`, `/bridge/close-out`, the
approval announcement and the privacy announcement did not. So a Bridge that
had stopped working would raise the banner if the failure happened to occur
during a contradiction, and stay silent about it otherwise — the dashboard
claiming voice was healthy while Echo was mute.

That is the failure mode `degradation.py` exists to prevent, reintroduced by
having five call sites instead of one.

────────────────────────────────────────────────────────────────────────────
WHAT THIS IS NOT

Not a place where sentences are composed, and not a place where §6 is
decided. `utterance.py` composes and validates; `BridgeController.speak`
validates again at the channel boundary. This coordinates — it owns the agent
lookup, the client, and the degradation bookkeeping, and nothing else.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal

import httpx

from ..adapters.agora_bridge import BridgeController, SpeakResult

if TYPE_CHECKING:
    from .session import IncidentSession

log = logging.getLogger("echo.speech")

Priority = Literal["high", "normal"]


class SpeechCoordinator:
    """
    Owns every proactive word Echo says, and the record of whether it landed.

    Constructed per call rather than held: the agent id changes when Zone 2
    invites a replacement, and caching a controller across that boundary is
    how `/speak` ended up being issued against an agent that had already left
    the channel.
    """

    def __init__(
        self,
        session: "IncidentSession",
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._session = session
        self._client = client

    # -- the agent lookup --------------------------------------------------

    def _controller(self) -> BridgeController | None:
        """None when no agent is registered — a normal state, not an error."""
        agent = self._session.agent
        if not agent["agent_id"] or not agent["channel"]:
            return None
        return BridgeController(
            agent["channel"], agent["agent_id"], client=self._client,
        )

    @property
    def has_agent(self) -> bool:
        return self._controller() is not None

    # -- the single speaking path ------------------------------------------

    async def say(
        self,
        text: str,
        *,
        priority: Priority = "high",
        preempt: bool = False,
        force: bool = False,
        dedupe_key: str | None = None,
    ) -> SpeakResult | None:
        """
        Speak `text`, and record what happened to the voice channel.

        Returns None when there was no agent to speak through, or when the
        Bridge suppressed the line (interruption floor, coalescing) — both are
        normal operation. The caller distinguishes them with `has_agent` if it
        needs to.

        `preempt=True` interrupts whatever Echo is mid-sentence first. Reserved
        for the two cases §5.1 lists as high priority: an adjudicated
        contradiction and an authorization request.
        """
        controller = self._controller()
        if controller is None:
            return None

        async with controller as bridge:
            if preempt:
                result = await bridge.speak_now(text)
            else:
                result = await bridge.speak(
                    text, priority=priority, force=force, dedupe_key=dedupe_key,
                )

        await self._record(result)
        return result

    async def interrupt(self) -> bool:
        controller = self._controller()
        if controller is None:
            return False
        async with controller as bridge:
            return await bridge.interrupt()

    # -- degradation bookkeeping, in exactly one place ---------------------

    async def _record(self, result: SpeakResult | None) -> None:
        """
        Publish the voice degradation banner, but only on a TRANSITION.

        §13: losing the Bridge must not lose the finding. By the time this runs
        the contradiction (or task, or timeline event) is already on the
        dashboard — all that was lost is Echo saying it aloud, and the banner
        makes that explicit rather than leaving the room wondering why it went
        quiet.

        A suppressed utterance (`result is None` from the interruption floor)
        is NOT a failure and must not raise the banner: the Bridge deliberately
        declined to speak, which is it working correctly.
        """
        if result is None:
            return

        session = self._session
        if not result.ok:
            if session.degraded.voice_failed(f"bridge /speak failed ({result.status})"):
                await session.hub.publish({"degraded": session.degraded.to_wire()})
        elif session.degraded.voice_restored():
            await session.hub.publish({"degraded": session.degraded.to_wire()})
