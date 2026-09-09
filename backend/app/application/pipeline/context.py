"""
Pipeline Context.

Shared state object threaded through each step of the analysis pipeline.
Holds the in-flight transcript window, extraction outputs, reconciliation mappings,
accumulated delta payload, and speech/contradiction results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.domain.models import Claim, Transcript
from app.domain.policies.reconciliation import EntityReconciler

if TYPE_CHECKING:
    from app.application.services.session import IncidentSession
    from app.application.services.speech import SpeechCoordinator


@dataclass
class PipelineContext:
    session: "IncidentSession"
    speech: "SpeechCoordinator"

    # Stage 1: Window Drain
    flushed: bool = False
    frames: list[Transcript] = field(default_factory=list)
    raw_text: str = ""

    # Stage 2: LLM Extraction
    extraction_result: dict[str, Any] = field(default_factory=dict)

    # Stage 3: Entity Reconciliation & Re-indexing
    reconciler: EntityReconciler | None = None

    # Stage 4: Mutations & Accumulated Delta
    delta: dict[str, Any] = field(default_factory=dict)
    new_claims: list[Claim] = field(default_factory=list)

    # Stage 5: Contradiction & Speech
    held_contradiction: tuple[Claim, Claim, Any] | None = None
    spoken: dict[str, Any] | None = None

    @property
    def should_continue(self) -> bool:
        """True if the window was flushed and frames were successfully extracted."""
        return self.flushed and bool(self.frames)
