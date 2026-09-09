"""
Ledger Ingestion Step.

Applies domain reconciliation policies to extracted elements and merges them into
the Evidence Ledger. Populates the phase 1 delta accumulator.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from app.application.services.extraction import entity_aliases
from app.domain.models import Claim, Link, Task, TimelineEvent, Unchecked
from app.domain.policies.reconciliation import EntityReconciler
from ..context import PipelineContext

log = logging.getLogger("echo.pipeline.ingest")


class LedgerIngestionStep:
    """Reconciles entities, validates claims & superseding, and updates the Ledger."""

    async def execute(self, ctx: PipelineContext) -> None:
        result = ctx.extraction_result
        if not result:
            return

        ledger = ctx.session.ledger

        def _merge(
            key: str,
            rows: list[dict[str, Any]],
            build: Callable[[dict[str, Any]], Any],
            upsert: Callable[[Any], None],
        ) -> None:
            made = []
            for row in rows:
                try:
                    obj = build(row)
                except (KeyError, TypeError, ValueError) as exc:
                    log.warning("pipeline: skipped a %s row: %s", key, exc)
                    continue
                upsert(obj)
                made.append(obj.to_wire())
            if made:
                ctx.delta[key] = made

        # 1. Entity reconciliation & de-duplication
        reconciler = EntityReconciler(entity_aliases(ledger))
        ctx.reconciler = reconciler

        _merge(
            "entities",
            result.get("entities", []),
            reconciler.reconcile_entity,
            ledger.upsert_entity,
        )

        # 2. Links re-indexed against reconciler mapping
        _merge(
            "links",
            result.get("links", []),
            lambda r: Link(
                id=r["id"],
                source=reconciler.reindex(r["source"]),
                target=reconciler.reindex(r["target"]),
                label=r.get("label", ""),
                kind=r.get("kind", "suspected"),
            ),
            ledger.upsert_link,
        )

        # 3. Claims re-indexed and validated against supersedes target
        def _claim_upsert(c: Claim) -> None:
            ledger.upsert_claim(c)
            ctx.new_claims.append(c)

        def _supersedes(row: dict[str, Any]) -> str | None:
            raw = row.get("supersedes")
            if not raw or not isinstance(raw, str):
                return None
            target = raw.strip()
            if not target or target == str(row.get("id", "")).strip():
                return None
            if target not in ledger.claims:
                log.info(
                    "pipeline: dropped supersedes=%r on %r (no such claim)",
                    target,
                    row.get("id"),
                )
                return None
            return target

        _merge(
            "claims",
            result.get("claims", []),
            lambda r: Claim(
                id=r["id"],
                text=r["text"],
                entity=reconciler.reindex(r.get("entity")) or None,
                epistemic_status=r["epistemicStatus"],
                speaker_role=r["speakerRole"],
                confidence=float(r.get("confidence", 0.8)),
                supersedes=_supersedes(r),
                speaker_name=r.get("speakerName"),
                speaker_user_id=r.get("speakerUserId"),
            ),
            _claim_upsert,
        )

        # 4. Secondary elements
        _merge(
            "unchecked",
            result.get("unchecked", []),
            lambda r: Unchecked(
                id=r["id"],
                description=r["description"],
                suggested_owner=r.get("suggestedOwner"),
            ),
            ledger.upsert_unchecked,
        )

        _merge(
            "tasks",
            result.get("tasks", []),
            lambda r: Task(
                id=r["id"],
                assignee_role=r["assigneeRole"],
                description=r["description"],
                status=r.get("status", "OPEN"),
                evidence=r.get("evidence") or [],
            ),
            ledger.upsert_task,
        )

        _merge(
            "timeline",
            result.get("timeline", []),
            lambda r: TimelineEvent(
                id=r["id"],
                kind=r.get("kind", "signal"),
                text=r["text"],
                actor=r.get("actor", "Echo"),
            ),
            ledger.add_timeline,
        )
