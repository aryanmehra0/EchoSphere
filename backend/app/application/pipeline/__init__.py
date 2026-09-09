"""
EchoSphere Modular Pipeline (Pipes-and-Filters Architecture).
"""

from .context import PipelineContext
from .runner import PipelineRunner
from .steps import (
    ContradictionDeliberationStep,
    LedgerIngestionStep,
    LlmExtractionStep,
    PrimaryDeltaPublishStep,
    WindowDrainStep,
    surface_contradiction,
)

_default_runner = PipelineRunner()


async def run_if_ready(session, speech):
    """Extract current window if ready and look for conflict."""
    return await _default_runner.run(session, speech)


__all__ = [
    "ContradictionDeliberationStep",
    "LedgerIngestionStep",
    "LlmExtractionStep",
    "PipelineContext",
    "PipelineRunner",
    "PrimaryDeltaPublishStep",
    "WindowDrainStep",
    "run_if_ready",
    "surface_contradiction",
]
