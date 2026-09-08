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
import re
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

        # Every id this window rewrote: original -> final. Links and claims
        # still refer to the ORIGINAL ids the model emitted, so without this
        # they point at entities that no longer exist. See `_reindex` below.
        renamed: dict[str, str] = {}

        def _entity(r: dict[str, Any]) -> Entity:
            proposed = str(r["id"]).strip()
            label = str(r.get("label", proposed)).strip()
            canonical = known_aliases.get(label.lower()) or known_aliases.get(proposed.lower())

            resolved_id = canonical or proposed

            """
            ── A VAGUE ID MUST NOT KEEP A SPECIFIC LABEL ────────────────────
            The extraction prompt says: when someone says "the database",
            emit `database-unspecified` rather than guessing `postgres-primary`.
            That is right — inventing a system name is worse than admitting
            ignorance.

            But it interacts badly with the alias merge above. Observed live:

                "the database is down"  -> id database-unspecified
                "the Redis is also down" -> label "Redis", merged onto that id

            leaving a row reading `id=database-unspecified, label=Redis`. The
            graph showed "Redis" and the record said database, which is
            confusing on its own — and actively wrong later, because a genuine
            Postgres claim would then resolve onto the alias table's
            `database-unspecified` and land on the REDIS node. Two real
            systems, one id, claims silently pooled.

            So when a specific label arrives on an `-unspecified` id, the id is
            promoted to match the label. The merge is still honoured (the
            claims stay together, which is what fixed contradiction scoping),
            but the id stops lying about which system it is.
            """
            if label and resolved_id.endswith("-unspecified"):
                specific = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
                """
                A LABEL IS ONLY SPECIFIC IF IT NAMES SOMETHING.

                "the database" slugs to `the-database`, which is strictly worse
                than `database-unspecified`: it reads like a real system name
                while carrying exactly as little information, and it drops the
                `-unspecified` marker that tells a reader nobody said WHICH
                database. Vague labels are left alone.

                `vague` is the generic-noun set the extraction prompt itself
                warns about, plus a leading article, which is the form a vague
                mention almost always takes on a bridge.
                """
                vague = {
                    "database", "the-database", "a-database", "db", "the-db",
                    "cache", "the-cache", "service", "the-service",
                    "server", "the-server", "queue", "the-queue",
                    "network", "the-network", "system", "the-system",
                    "api", "the-api", "app", "the-app",
                }
                if specific and specific not in vague and not specific.endswith("-unspecified"):
                    log.info(
                        "pipeline: promoted entity %r -> %r (label %r names a system)",
                        resolved_id, specific, label,
                    )
                    resolved_id = specific

            # Record the rewrite so links and claims can follow it.
            if resolved_id != proposed:
                renamed[proposed] = resolved_id

            return Entity(
                id=resolved_id,
                label=label or proposed,
                aliases=[str(a) for a in (r.get("aliases") or [])],
                kind=r.get("kind", "service"),
                status=r.get("status", "UNKNOWN"),
                detail=r.get("detail"),
                metric=r.get("metric"),
            )

        _merge("entities", result["entities"], _entity, ledger.upsert_entity)

        def _reindex(entity_id: Any) -> str:
            """
            Follow an entity id through this window's renames.

            ── WHY THE GRAPH HAD NODES BUT NO EDGES ────────────────────────
            `_entity` above rewrites ids in two ways — the alias merge, and
            the `-unspecified` promotion — but links and claims still carry
            the ORIGINAL id the model emitted. Measured live on one sentence
            ("the checkout service reads from the primary Redis shard, and
            Redis writes to the Postgres replica"):

                entities:  checkout-service      primary-redis-shard
                links:     checkout-service-unspecified -> redis-shard-unspecified

            Both endpoints named entities that no longer existed, and React
            Flow drops an edge whose endpoints match no node — SILENTLY. So
            the canvas showed three unconnected boxes and the header read
            `3n · 0e`, which looks like link extraction was never built.

            It was built and working; the ids were rewritten out from under
            it. `resolve_links` already guards against claim-ids and causal
            labels, but it runs BEFORE this promotion and cannot know about
            it.
            """
            raw = str(entity_id or "").strip()
            return renamed.get(raw, raw)

        _merge("links", result["links"],
               lambda r: Link(id=r["id"],
                              source=_reindex(r["source"]),
                              target=_reindex(r["target"]),
                              label=r.get("label", ""), kind=r.get("kind", "suspected")),
               ledger.upsert_link)

        new_claims: list[Claim] = []

        def _claim_upsert(c: Claim) -> None:
            ledger.upsert_claim(c)
            new_claims.append(c)

        def _supersedes(row: dict[str, Any]) -> str | None:
            """
            The id this claim retires, if it genuinely retires one.

            ── WHY THIS IS VALIDATED AND NOT PASSED STRAIGHT THROUGH ────────
            `supersedes` was never read at all: the extraction prompt did not
            ask for it, this lambda did not pass it, and every row in the
            database had it NULL — including claims literally beginning
            "Correction,". So a speaker revising their own measurement
            ("correction, memory is actually 95 percent, not 40") produced a
            SECOND claim alongside the first, the contradiction engine found
            two incompatible values for one property, and Echo interrupted
            the room to report that somebody disagreed with themselves.

            Reported live, and it makes Echo look like it is not listening.

            Now that the model is asked for the field, it will sometimes
            invent an id. A dangling `supersedes` is worse than none: the
            Ledger's `superseded_ids()` would retire nothing while the claim
            it names is still live, and `open_hypotheses` would quietly
            include a settled question. So the id must exist.

            Self-reference is dropped too — a claim cannot supersede itself,
            and a model that emits `id == supersedes` would otherwise retire
            the very row being added.
            """
            raw = row.get("supersedes")
            if not raw or not isinstance(raw, str):
                return None
            target = raw.strip()
            if not target or target == str(row.get("id", "")).strip():
                return None
            if target not in ledger.claims:
                log.info(
                    "pipeline: dropped supersedes=%r on %r (no such claim)",
                    target, row.get("id"),
                )
                return None
            return target

        _merge("claims", result["claims"],
               # `_reindex` on the entity too: a claim pointing at a renamed
               # id is worse than a dropped edge, because contradiction
               # scoping keys on `entity` equality and would silently find no
               # candidates — the exact silent failure §7 was built to end.
               lambda r: Claim(id=r["id"], text=r["text"],
                               entity=_reindex(r.get("entity")) or None,
                               epistemic_status=r["epistemicStatus"],
                               speaker_role=r["speakerRole"],
                               confidence=float(r.get("confidence", 0.8)),
                               supersedes=_supersedes(r)),
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
