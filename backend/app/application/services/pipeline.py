"""
The ingestion pipeline — W2 then W3, the core path and the headline workflow.

    window -> redact -> extract -> validate -> Ledger -> deltas
                                                  |
                                                  +-> contradiction -> Bridge

Refactored to Pipes-and-Filters architecture via `app.application.pipeline`.
Preserves 100% of the public interface, locking semantics, and error recovery invariants.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from app.application.pipeline.runner import PipelineRunner
from app.application.pipeline.steps.deliberate import surface_contradiction
from app.application.services.extraction import compact, entity_aliases, extract
from app.domain.models import (
    Claim,
    Contradiction,
    Entity,
    Link,
    Task,
    TimelineEvent,
    Unchecked,
    now_ms,
)
from app.domain.policies.reconciliation import EntityReconciler
from app.domain.policies.utterance import EpistemicViolation, contradiction_intervention
from app.infrastructure.agora_bridge import BridgeController

if TYPE_CHECKING:
    from .session import IncidentSession
    from .speech import SpeechCoordinator

log = logging.getLogger("echo.pipeline")

_default_runner = PipelineRunner()


async def run_if_ready(
    session: "IncidentSession",
    speech: "SpeechCoordinator",
) -> dict[str, Any] | None:
    """
    Extract the current window if it is due, merge it, then look for conflict.

    Guarded by the session's lock because both the flush ticker and an
    incoming frame can reach here: extracting the same window twice would
    double every claim in it.
    """
    return await _default_runner.run(session, speech)


__all__ = [
    "BridgeController",
    "Claim",
    "Contradiction",
    "Entity",
    "EntityReconciler",
    "EpistemicViolation",
    "Link",
    "PipelineRunner",
    "Task",
    "TimelineEvent",
    "Unchecked",
    "compact",
    "contradiction_intervention",
    "entity_aliases",
    "extract",
    "now_ms",
    "run_if_ready",
    "surface_contradiction",
]
