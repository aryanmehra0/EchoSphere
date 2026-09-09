"""
The Degradation Ladder — v6 §13 and W10.

    The governing principle: NO SINGLE DEPENDENCY CAN TAKE DOWN THE DEMO.

The Fast Loop and Slow Loop fail independently by design. Losing voice leaves a
working real-time incident dashboard. Losing analytics leaves a working
conversational agent. Losing the Bridge leaves both, minus proactive
interruption — and the contradiction still lands on the dashboard, so the story
still tells.

That property is not a happy accident of the Dual-Loop split; it is the main
operational reason to prefer it over one integrated model.

This module holds the state and, crucially, MAKES IT VISIBLE. A system quietly
running in a degraded mode is worse than one that has obviously failed: the
operator keeps trusting output that is no longer complete. §13's table has a
"demo-visible impact" column for exactly this reason.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("echo.degradation")


@dataclass
class Degradation:
    """What is currently broken, in the operator's language rather than ours."""

    voice: bool = False
    """The Bridge cannot make Echo speak. Analytics unaffected."""

    analysis_model: str | None = None
    """Set when running on a FALLBACK model rather than the primary."""

    extraction: bool = False
    """Extraction is failing. The graph pauses; the timeline continues."""

    notes: list[str] = field(default_factory=list)

    @property
    def any(self) -> bool:
        return self.voice or self.extraction or self.analysis_model is not None

    def banner(self) -> str | None:
        """
        One short line for the command bar.

        Deliberately names the CONSEQUENCE, not the component. "Echo is silent"
        tells an operator what to expect; "bridge controller unavailable" makes
        them guess.
        """
        if self.voice and self.extraction:
            return "ANALYTICS AND VOICE DEGRADED — dashboard may be incomplete"
        if self.voice:
            return "ANALYTICS ONLY — Echo cannot speak; conflicts appear here"
        if self.extraction:
            return "EXTRACTION PAUSED — the graph may lag behind the transcript"
        if self.analysis_model:
            return f"FALLBACK MODEL — running on {self.analysis_model}"
        return None

    def to_wire(self) -> dict[str, Any]:
        return {
            "voice": self.voice,
            "extraction": self.extraction,
            "model": self.analysis_model,
            "banner": self.banner(),
        }

    # -- transitions -------------------------------------------------------

    def voice_failed(self, why: str) -> bool:
        """Returns True when this is a CHANGE, so callers only publish on edges."""
        if self.voice:
            return False
        self.voice = True
        self.notes.append(why)
        log.error("degradation: voice lost — %s", why)
        return True

    def voice_restored(self) -> bool:
        if not self.voice:
            return False
        self.voice = False
        log.info("degradation: voice restored")
        return True

    def using_fallback_model(self, model: str) -> bool:
        if self.analysis_model == model:
            return False
        self.analysis_model = model
        log.warning("degradation: analysis running on fallback %s", model)
        return True

    def primary_model_restored(self) -> bool:
        if self.analysis_model is None:
            return False
        self.analysis_model = None
        log.info("degradation: primary analysis model restored")
        return True
