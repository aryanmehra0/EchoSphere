"""
Window Drain Step.

Inspects the session Turn Window to determine if a flush is due.
If due, atomically drains queued transcript frames and formats the window text.
"""

from __future__ import annotations

import logging

from ..context import PipelineContext

log = logging.getLogger("echo.pipeline.drain")


class WindowDrainStep:
    """Evaluates silence/size flush triggers and drains frames."""

    async def execute(self, ctx: PipelineContext) -> None:
        window = ctx.session.window
        if not window.should_flush():
            return

        frames = window.drain()
        if not frames:
            return

        ctx.frames = frames
        ctx.flushed = True
        ctx.raw_text = "\n".join(f"[{f.role}] {f.text}" for f in frames)
        log.info("pipeline: extracting a %d-frame window", len(frames))

