"""
The ingestion pipeline — W2 then W3, the core path and the headline workflow.

    window -> redact -> extract -> validate -> Ledger -> deltas
                                                  |
                                                  +-> contradiction -> Bridge

────────────────────────────────────────────────────────────────────────────
WHY THIS IS NOT IN `main.py` ANY MORE

It was 178 lines inside the module that also held 24 route handlers, the auth
middleware and eight mutable globals. Two consequences:

  - it could not be exercised without importing the FastAPI app, so the Rig
    had to reach it over HTTP even for Tier 2, which is meant to measure
    extraction quality rather than the web layer;
  - the state it operates on was module-global, so there was exactly one
    incident per process.

Nothing about the ALGORITHM changed in the move. The requeue-on-failure rule,
the entity de-duplication, the one-interruption-per-window rule and the
OPPOSED short-circuit are all as they were — each of them exists because of a
specific measured failure, and the comments recording those failures moved
with the code.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from ..adapters.agora_bridge import BridgeController
from ..extraction import compact, entity_aliases, extract
from ..models import (
    Claim,
    Contradiction,
    Entity,
    Link,
    Task,
    TimelineEvent,
    Unchecked,
    now_ms,
)
from ..utterance import EpistemicViolation, contradiction_intervention

if TYPE_CHECKING:
    from .session import IncidentSession
    from .speech import SpeechCoordinator

log = logging.getLogger("echo.pipeline")


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
    ledger = session.ledger
    hub = session.hub
    window = session.window
    engine = session.engine

    async with session.pipeline_lock:
        if not window.should_flush():
            return None

        frames = window.drain()
        if not frames:
            return None

        text = "\n".join(f"[{f.role}] {f.text}" for f in frames)
        log.info("pipeline: extracting a %d-frame window", len(frames))

        # Carry the Ledger's alias table so entity ids stay stable across
        # windows — "Redis" in window 3 must resolve to the id it got in
        # window 1, or contradiction scoping silently finds nothing.
        try:
            result = await extract(text, compact(ledger), aliases=entity_aliases(ledger))
        except Exception:  # noqa: BLE001 — see below; never lose an utterance
            """
            PUT THE WINDOW BACK.

            `drain()` empties the window before extraction runs, so an
            extraction that raised used to take those frames with it — the
            words were spoken, and then simply were not in the record. Groq's
            per-minute limit is per organisation, so a busy moment on the
            bridge is exactly when this fires: the analysis matters most and
            the claims vanish quietest.

            That is not an acceptable failure for an evidence ledger. The
            frames go back and the flush ticker retries them a second later,
            by which time the per-minute budget has usually recovered.

            `window.add` dedupes on message id, so a frame that partially
            succeeded cannot be counted twice.
            """
            log.exception(
                "pipeline: extraction failed on %d frame(s) — requeued", len(frames),
            )
            for frame in frames:
                window.requeue(frame)
            return None

        # -- merge ---------------------------------------------------------
        delta: dict[str, Any] = {}

        def _merge(key: str, rows: list[dict[str, Any]], build, upsert) -> None:
            made = []
            for row in rows:
                try:
                    obj = build(row)
                except (KeyError, TypeError, ValueError) as exc:
                    # One malformed row must not cost the whole window.
                    log.warning("pipeline: skipped a %s row: %s", key, exc)
                    continue
                upsert(obj)
                made.append(obj.to_wire())
            if made:
                delta[key] = made

        # Entity de-duplication.
        #
        # The model re-proposes the same real-world thing under a fresh id every
        # window ("e2" then "cache" for Redis). Creating both gives four graph
        # nodes for two systems AND splits the claims between them, which is
        # what silently disabled contradiction detection. Map a duplicate label
        # onto the id that already exists instead.
        known_aliases = entity_aliases(ledger)

        def _entity(r: dict[str, Any]) -> Entity:
            proposed = str(r["id"]).strip()
            label = str(r.get("label", proposed)).strip()
            canonical = known_aliases.get(label.lower()) or known_aliases.get(proposed.lower())
            return Entity(
                id=canonical or proposed,
                label=label or proposed,
                aliases=[str(a) for a in (r.get("aliases") or [])],
                kind=r.get("kind", "service"),
                status=r.get("status", "UNKNOWN"),
                detail=r.get("detail"),
                metric=r.get("metric"),
            )

        _merge("entities", result["entities"], _entity, ledger.upsert_entity)

        _merge("links", result["links"],
               lambda r: Link(id=r["id"], source=r["source"], target=r["target"],
                              label=r.get("label", ""), kind=r.get("kind", "suspected")),
               ledger.upsert_link)

        new_claims: list[Claim] = []

        def _claim_upsert(c: Claim) -> None:
            ledger.upsert_claim(c)
            new_claims.append(c)

        _merge("claims", result["claims"],
               lambda r: Claim(id=r["id"], text=r["text"], entity=r.get("entity"),
                               epistemic_status=r["epistemicStatus"],
                               speaker_role=r["speakerRole"],
                               confidence=float(r.get("confidence", 0.8))),
               _claim_upsert)

        _merge("unchecked", result["unchecked"],
               lambda r: Unchecked(id=r["id"], description=r["description"],
                                   suggested_owner=r.get("suggestedOwner")),
               ledger.upsert_unchecked)

        _merge("tasks", result["tasks"],
               lambda r: Task(id=r["id"], assignee_role=r["assigneeRole"],
                              description=r["description"], status=r.get("status", "OPEN"),
                              evidence=r.get("evidence") or []),
               ledger.upsert_task)

        _merge("timeline", result["timeline"],
               lambda r: TimelineEvent(id=r["id"], kind=r.get("kind", "signal"),
                                       text=r["text"], actor=r.get("actor", "Echo")),
               ledger.add_timeline)

        if delta:
            envelope = await hub.publish(delta)
            log.info("pipeline: published seq=%s", envelope.get("seq"))

        # -- W3: does anything now conflict? -------------------------------
        spoken = None
        existing = list(ledger.claims.values())

        # Recomputed AFTER the merge above, not reused from before it: a claim
        # that named an entity first seen in THIS window can only be scoped
        # against it once that entity is in the table.
        scope_aliases = entity_aliases(ledger)

        """
        ONE INTERRUPTION PER WINDOW - BUT THE RIGHT ONE.

        This loop used to break on the first claim that produced ANY actionable
        verdict. §5.1's single-slot queue says speak once per window, and that
        is correct; what was wrong was letting arrival order decide WHICH.

        Seen in validation: Act 1's "carts empty" and "latency is through the
        roof" adjudicated INDEPENDENT - true, they are different properties -
        and the loop stopped there. The pair the whole demo turns on, "the
        cache is fine" against "cache read timeouts", was never reached.

        OPPOSED short-circuits, since nothing outranks two claims that cannot
        both be true. Anything else is held while the remaining claims are
        checked. The extra evaluations land only when the first hit was the
        weaker kind, and `ContradictionEngine.evaluate` still enforces its own
        panel budget underneath, so the 429 ceiling is unchanged.
        """
        held: tuple[Claim, Claim, Any] | None = None

        for claim in new_claims:
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
            claim, other, verdict = held
            spoken = await surface_contradiction(session, speech, claim, other, verdict)

        return {"claims": len(new_claims), "delta": bool(delta), "spoken": spoken}


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
    # A PanelVerdict carries the deliberation; the legacy Adjudication does not.
    panel = verdict.as_dict() if hasattr(verdict, "positions") else None

    cx = Contradiction(id=f"cx-{now_ms()}", claim_a=a.id, claim_b=b.id,
                       speakers=[a.speaker_role, b.speaker_role], relation=relation,
                       why=getattr(verdict, "why", None) or None, panel=panel)
    ledger.upsert_contradiction(cx)
    event = ledger.add_timeline(TimelineEvent(
        id=f"tl-{now_ms()}", kind="contradiction",
        text="Two observations are in tension. Echo intervening.", actor="Echo",
    ))
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

    # `preempt` — an adjudicated contradiction is one of the two cases §5.1
    # allows to interrupt. The degradation edge is recorded by the coordinator,
    # so losing the Bridge here raises the banner rather than going quiet.
    result = await speech.say(line, preempt=True)

    return {"spoken": bool(result and result.ok), "text": line}
