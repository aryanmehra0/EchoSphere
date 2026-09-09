"""
LLM Extraction Step.

Invokes the extraction engine over the window text and compacted incident state.
Carries the ledger's alias table to ensure entity IDs remain stable across windows.
Enforces the critical 429 requeue invariant: on any extraction exception, all drained
frames are restored back into the Turn Window so human speech is never lost.
"""

from __future__ import annotations

import logging

from app.application.services.extraction import compact, entity_aliases, extract
from ..context import PipelineContext

log = logging.getLogger("echo.pipeline.extract")


class LlmExtractionStep:
    """Executes structured knowledge extraction with frame restoration on failure."""

    async def execute(self, ctx: PipelineContext) -> None:
        if not ctx.flushed or not ctx.frames:
            return

        ledger = ctx.session.ledger
        window = ctx.session.window

        try:
            result = await extract(
                ctx.raw_text,
                compact(ledger),
                aliases=entity_aliases(ledger),
            )
            ctx.extraction_result = result
        except Exception:  # noqa: BLE001 — never lose an utterance under rate limits
            log.exception(
                "pipeline: extraction failed on %d frame(s) — requeued",
                len(ctx.frames),
            )
            for frame in ctx.frames:
                window.requeue(frame)
            ctx.frames.clear()
            ctx.flushed = False
            ctx.extraction_result.clear()
