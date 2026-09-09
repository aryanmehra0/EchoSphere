"""
Primary Delta Publish Step.

Enforces Invariant 2 (Two-Phase Delta Publishing Order):
Broadcasting the phase 1 delta (entities, links, claims, tasks, timeline)
to all connected dashboard clients BEFORE contradiction evaluation begins.
"""

from __future__ import annotations

import logging

from ..context import PipelineContext

log = logging.getLogger("echo.pipeline.publish")


class PrimaryDeltaPublishStep:
    """Publishes mutated incident elements to the Delta Hub."""

    async def execute(self, ctx: PipelineContext) -> None:
        if not ctx.delta:
            return

        envelope = await ctx.session.hub.publish(ctx.delta)
        log.info("pipeline: published seq=%s", envelope.get("seq"))

