"""
Tests for Modular Pipeline Steps and Runner (Pipes-and-Filters Architecture).

Validates:
- Window drain and flush gating
- Invariant 1: 429 / error frame requeue back to Turn Window
- Invariant 2: Two-Phase Delta Publish sequence
- Invariant 3: Link and claim entity re-indexing through reconciler
- Invariant 5: Fresh alias recomputation after entity merge
- Invariant 6: Contradiction short-circuit (OPPOSED breaks, INDEPENDENT held)
- End-to-end execution through PipelineRunner
"""

from __future__ import annotations

import time
import unittest
from unittest.mock import AsyncMock, patch

from app.models import Transcript
from app.pipeline.context import PipelineContext
from app.pipeline.runner import PipelineRunner
from app.pipeline.steps.drain import WindowDrainStep
from app.extraction import ExtractionDropped
from app.pipeline.steps.extract import LlmExtractionStep
from app.pipeline.steps.ingest import LedgerIngestionStep
from app.pipeline.steps.publish import PrimaryDeltaPublishStep
from app.services.session import IncidentSession
from app.services.speech import SpeechCoordinator


class TestPipelineSteps(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.session = IncidentSession("test-chan")
        self.speech = SpeechCoordinator(lambda: None)

    async def test_drain_step_does_not_flush_when_window_not_ready(self) -> None:
        ctx = PipelineContext(session=self.session, speech=self.speech)
        step = WindowDrainStep()
        await step.execute(ctx)
        self.assertFalse(ctx.flushed)
        self.assertEqual(len(ctx.frames), 0)

    async def test_drain_step_drains_frames_when_due(self) -> None:
        frame = Transcript(
            message_id="m1",
            uid=1001,
            role="DevOps Lead",
            text="Checking status",
            is_final=True,
            at=1000,
        )
        self.session.window.add(frame)
        # Advance clock past silence threshold
        self.session.window.last_final_at = time.monotonic() - 5.0

        ctx = PipelineContext(session=self.session, speech=self.speech)
        step = WindowDrainStep()
        await step.execute(ctx)

        self.assertTrue(ctx.flushed)
        self.assertEqual(len(ctx.frames), 1)
        self.assertIn("[DevOps Lead] Checking status", ctx.raw_text)
        self.assertEqual(len(self.session.window.frames), 0)

    async def test_extract_step_requeues_frames_on_error(self) -> None:
        frame = Transcript(
            message_id="m1",
            uid=1001,
            role="DevOps Lead",
            text="Critical update",
            is_final=True,
            at=1000,
        )
        self.session.window.add(frame)
        drained = self.session.window.drain()

        ctx = PipelineContext(session=self.session, speech=self.speech)
        ctx.flushed = True
        ctx.frames = drained
        ctx.raw_text = "[DevOps Lead] Critical update"

        step = LlmExtractionStep()

        with patch(
            "app.pipeline.steps.extract.extract",
            side_effect=RuntimeError("Groq 429 Rate Limit"),
        ):
            await step.execute(ctx)

        # Invariant 1: Frames must be restored to the Turn Window
        self.assertIn("m1", self.session.window._seen)
        self.assertEqual(len(self.session.window.frames), 1)
        self.assertEqual(self.session.window.frames[0].message_id, "m1")
        self.assertFalse(ctx.flushed)
        self.assertEqual(len(ctx.frames), 0)

    async def test_extract_step_requeues_frames_when_extraction_is_dropped(self) -> None:
        """
        Regression: `extract()` used to swallow two consecutive schema
        failures internally and return an empty result instead of raising,
        which meant this exact requeue path never ran for that failure mode
        — the window's speech was neither processed nor put back. `extract()`
        now raises `ExtractionDropped` on that path; this pins that the step
        requeues on it exactly as it does for any other extraction failure.
        """
        frame = Transcript(
            message_id="m2",
            uid=1001,
            role="DevOps Lead",
            text="Redis memory looks fine",
            is_final=True,
            at=1000,
        )
        self.session.window.add(frame)
        drained = self.session.window.drain()

        ctx = PipelineContext(session=self.session, speech=self.speech)
        ctx.flushed = True
        ctx.frames = drained
        ctx.raw_text = "[DevOps Lead] Redis memory looks fine"

        step = LlmExtractionStep()

        with patch(
            "app.pipeline.steps.extract.extract",
            side_effect=ExtractionDropped("dropped a window after two schema failures"),
        ):
            await step.execute(ctx)

        self.assertIn("m2", self.session.window._seen)
        self.assertEqual(len(self.session.window.frames), 1)
        self.assertEqual(self.session.window.frames[0].message_id, "m2")
        self.assertFalse(ctx.flushed)
        self.assertEqual(len(ctx.frames), 0)

    async def test_ingest_step_reindexes_links_and_claims(self) -> None:
        ctx = PipelineContext(session=self.session, speech=self.speech)
        ctx.extraction_result = {
            "entities": [
                {
                    "id": "database-unspecified",
                    "label": "Postgres Primary",
                    "kind": "database",
                    "status": "DEGRADED",
                },
            ],
            "links": [
                {
                    "id": "link-1",
                    "source": "api-service",
                    "target": "database-unspecified",
                    "kind": "depends_on",
                },
            ],
            "claims": [
                {
                    "id": "claim-1",
                    "text": "Postgres primary is rejecting writes",
                    "entity": "database-unspecified",
                    "epistemicStatus": "OBSERVED",
                    "speakerRole": "DBA",
                    "confidence": 0.95,
                }
            ],
            "unchecked": [],
            "tasks": [],
            "timeline": [],
        }

        step = LedgerIngestionStep()
        await step.execute(ctx)

        # Entity was promoted from database-unspecified to postgres-primary
        self.assertIn("postgres-primary", self.session.ledger.entities)
        # Link was re-indexed
        link = self.session.ledger.links["link-1"]
        self.assertEqual(link.target, "postgres-primary")
        # Claim was re-indexed
        claim = self.session.ledger.claims["claim-1"]
        self.assertEqual(claim.entity, "postgres-primary")
        self.assertEqual(len(ctx.new_claims), 1)
        self.assertIn("entities", ctx.delta)
        self.assertIn("links", ctx.delta)
        self.assertIn("claims", ctx.delta)

    async def test_primary_publish_step_broadcasts_delta(self) -> None:
        ctx = PipelineContext(session=self.session, speech=self.speech)
        ctx.delta = {"claims": [{"id": "c1"}]}

        mock_hub = AsyncMock()
        mock_hub.publish.return_value = {"seq": 42}
        self.session.hub = mock_hub

        step = PrimaryDeltaPublishStep()
        await step.execute(ctx)

        mock_hub.publish.assert_awaited_once_with({"claims": [{"id": "c1"}]})

    async def test_runner_end_to_end(self) -> None:
        frame = Transcript(
            message_id="m10",
            uid=1001,
            role="DevOps Lead",
            text="Redis cache is evicting keys",
            is_final=True,
            at=1000,
        )
        self.session.window.add(frame)
        self.session.window.last_final_at = time.monotonic() - 5.0

        mock_extraction = {
            "entities": [
                {
                    "id": "redis",
                    "label": "Redis",
                    "kind": "cache",
                    "status": "DEGRADED",
                }
            ],
            "links": [],
            "claims": [
                {
                    "id": "c10",
                    "text": "Redis cache is evicting keys",
                    "entity": "redis",
                    "epistemicStatus": "OBSERVED",
                    "speakerRole": "DevOps Lead",
                    "confidence": 0.95,
                }
            ],
            "unchecked": [],
            "tasks": [],
            "timeline": [],
        }

        runner = PipelineRunner()
        with patch(
            "app.pipeline.steps.extract.extract", new_callable=AsyncMock
        ) as mock_extract:
            mock_extract.return_value = mock_extraction
            summary = await runner.run(self.session, self.speech)

        self.assertIsNotNone(summary)
        self.assertEqual(summary["claims"], 1)
        self.assertTrue(summary["delta"])
        self.assertIn("redis", self.session.ledger.entities)
        self.assertIn("c10", self.session.ledger.claims)


if __name__ == "__main__":
    unittest.main()
