"""
Contradiction Deliberation Step.

Evaluates newly extracted claims against existing evidence in the Ledger.
Enforces Invariant 5 (Fresh Alias Recalculation) and Invariant 6 (OPPOSED short-circuit).
Surfaces actionable conflicts via the Deliberation Panel, publishes phase 2 delta,
and triggers §6-validated preemptive speech on the voice bridge.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from app.application.services.extraction import entity_aliases
from app.domain.models import Claim, Contradiction, TimelineEvent, now_ms
from app.domain.policies.utterance import EpistemicViolation, contradiction_intervention
from app.infrastructure.agora_bridge import BridgeController
from ..context import PipelineContext

if TYPE_CHECKING:
    from app.application.services.session import IncidentSession
    from app.application.services.speech import SpeechCoordinator

log = logging.getLogger("echo.pipeline.deliberate")


async def surface_contradiction(
    session: "IncidentSession",
    speech: "SpeechCoordinator",
    a: Claim,
    b: Claim,
    verdict: Any,
) -> dict[str, Any] | None:
    """Record the conflict, then speak it — Rule 3 filtered, §6 validated."""
    if len(BridgeController.strip_inferred([a, b])) < 2:
        return None

    ledger = session.ledger
    relation = verdict.relation
    panel = verdict.as_dict() if hasattr(verdict, "positions") else None

    cx = Contradiction(
        id=f"cx-{now_ms()}",
        claim_a=a.id,
        claim_b=b.id,
        speakers=[a.speaker_role, b.speaker_role],
        relation=relation,
        why=getattr(verdict, "why", None) or None,
        panel=panel,
    )
    ledger.upsert_contradiction(cx)
    event = ledger.add_timeline(
        TimelineEvent(
            id=f"tl-{now_ms()}",
            kind="contradiction",
            text="Two observations are in tension. Echo intervening.",
            actor="Echo",
        )
    )
    await session.hub.publish(
        {"contradictions": [cx.to_wire()], "timeline": [event.to_wire()]}
    )

    gap = next(iter(ledger.open_unchecked()), None)
    try:
        line = contradiction_intervention(a, b, relation=relation, gap=gap)
    except EpistemicViolation as exc:
        log.error("pipeline: refused to speak a §6-violating line: %s", exc)
        return None

    if not speech.has_agent:
        return {"spoken": False, "text": line, "reason": "no agent registered"}

    result = await speech.say(line, preempt=True)
    return {"spoken": bool(result and result.ok), "text": line}


class ContradictionDeliberationStep:
    """Deliberates on claim conflicts and proactively intervenes on the audio bridge."""

    async def execute(self, ctx: PipelineContext) -> None:
        if not ctx.new_claims:
            return

        ledger = ctx.session.ledger
        engine = ctx.session.engine
        existing = list(ledger.claims.values())

        # Invariant 5: Recomputed AFTER the merge, so newly introduced entities
        # are included in scoping rules.
        scope_aliases = entity_aliases(ledger)

        # Invariant 6: One interruption per window, prioritizing OPPOSED.
        held: tuple[Claim, Claim, Any] | None = None

        for claim in ctx.new_claims:
            found = await engine.evaluate(claim, existing, aliases=scope_aliases)
            if not found:
                continue

            other, verdict = found
            if verdict.relation == "OPPOSED":
                held = (claim, other, verdict)
                break
            if held is None:
                held = (claim, other, verdict)

        if held is not None:
            ctx.held_contradiction = held
            claim, other, verdict = held
            ctx.spoken = await surface_contradiction(
                ctx.session, ctx.speech, claim, other, verdict
            )
