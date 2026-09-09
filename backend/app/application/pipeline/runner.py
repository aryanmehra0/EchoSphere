"""
Pipeline Runner.

Coordinates the Pipes-and-Filters sequence under session concurrency locks.
Enforces fail-safe frame requeue and clean return contract.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Sequence

from .context import PipelineContext
from .steps import (
    ContradictionDeliberationStep,
    LedgerIngestionStep,
    LlmExtractionStep,
    PrimaryDeltaPublishStep,
    WindowDrainStep,
)

if TYPE_CHECKING:
    from ..services.session import IncidentSession
    from ..services.speech import SpeechCoordinator

log = logging.getLogger("echo.pipeline.runner")


class PipelineRunner:
    """Orchestrates pipeline execution through modular steps."""

    def __init__(self, steps: Sequence[Any] | None = None) -> None:
        self.steps = steps or [
            WindowDrainStep(),
            LlmExtractionStep(),
            LedgerIngestionStep(),
            PrimaryDeltaPublishStep(),
            ContradictionDeliberationStep(),
        ]

    async def run(
        self,
        session: "IncidentSession",
        speech: "SpeechCoordinator",
    ) -> dict[str, Any] | None:
        """
        Execute the analysis pipeline under the session's concurrency lock.
        Returns a summary dict if a window was processed, or None otherwise.
        """
        async with session.pipeline_lock:
            ctx = PipelineContext(session=session, speech=speech)

            try:
                for step in self.steps:
                    await step.execute(ctx)
                    if not ctx.flushed:
                        return None
            except Exception:
                # Fallback safety: ensure frames are never orphaned if an error escapes
                if ctx.frames and not ctx.new_claims:
                    log.exception(
                        "pipeline: unexpected error during execution — requeuing %d frames",
                        len(ctx.frames),
                    )
                    for frame in ctx.frames:
                        session.window.requeue(frame)
                raise

            if not ctx.frames and not ctx.extraction_result:
                return None

            return {
                "claims": len(ctx.new_claims),
                "delta": bool(ctx.delta),
                "spoken": ctx.spoken,
            }

