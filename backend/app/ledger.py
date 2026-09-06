"""
The Evidence Ledger — v6 §6, §9.1.

One claim table discriminated by `epistemic_status`, not separate fact and
hypothesis arrays. That is what makes the fact-versus-assumption separation the
problem statement demands a QUERY rather than a convention.

Mirrors the selectors in `frontend/src/lib/incident-reducer.ts` so both sides of
the wire answer the same questions the same way.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

import logging
from dataclasses import fields as dataclass_fields

from . import store
from .models import (
    Claim,
    Contradiction,
    Entity,
    Link,
    Task,
    TimelineEvent,
    Unchecked,
    now_ms,
)


log = logging.getLogger("echo.ledger")


def _norm(text: str) -> str:
    """
    Normalise a claim for equality.

    Punctuation and casing differ between extraction passes for the same
    spoken sentence — "The cache is fine" and "the cache is fine." are one
    claim, and comparing raw strings would keep both.
    """
    return re.sub(r"[^a-z0-9 ]+", "", (text or "").lower()).strip()


@dataclass
class Ledger:
    """
    In-memory, session-scoped, single incident.

    Session-scoped is a §10.4 requirement, not a shortcut: transcripts and the
    vector index are purged at close-out, and an in-process store makes that
    guarantee trivially true.
    """

    incident_id: str = "INC-4417"
    started_at: int = field(default_factory=now_ms)
    phase: str = "triage"

    # Which bridge this record belongs to. Persisted rows are keyed
    # (channel, id) so a second incident cannot collide with the first.
    channel: str = "inc-4417"

    entities: dict[str, Entity] = field(default_factory=dict)
    links: dict[str, Link] = field(default_factory=dict)
    claims: dict[str, Claim] = field(default_factory=dict)
    unchecked: dict[str, Unchecked] = field(default_factory=dict)
    tasks: dict[str, Task] = field(default_factory=dict)
    contradictions: dict[str, Contradiction] = field(default_factory=dict)
    timeline: list[TimelineEvent] = field(default_factory=list)
    rti: float = 0.0

    # -- merge -------------------------------------------------------------

    def upsert_claim(self, claim: Claim) -> Claim:
        """
        Add a claim, unless this speaker already said it.

        ── WHY DEDUPE LIVES HERE AND NOT ONLY IN EXTRACTION ────────────────
        `extraction._dedupe_claims` collapses one assertion the model emitted
        twice IN A SINGLE WINDOW. It cannot see the Ledger, so the same
        sentence extracted from two overlapping windows produced two rows —
        which a Tier 3 run caught as "duplicate rows in the Ledger" only on
        the third consecutive pass, because it depends on where the window
        boundary happens to fall.

        Double-counting is not cosmetic here. The Ledger is what Echo reads
        aloud and what the contradiction engine scopes over: a claim recorded
        twice is a fact that looks corroborated when one person said it once.

        Matching is by speaker + normalised text. Two DIFFERENT people saying
        the same thing is agreement — a finding — and is deliberately kept.
        """
        incoming = _norm(claim.text)
        if incoming:
            for existing in self.claims.values():
                if existing.id == claim.id:
                    break  # a genuine update to a known row
                if (
                    existing.speaker_role == claim.speaker_role
                    and _norm(existing.text) == incoming
                ):
                    # Keep the more cautious reading, exactly as the in-window
                    # dedupe does: a claim recorded once as a fact and once as
                    # a guess is a guess.
                    if "HYPOTHESIS" in (existing.epistemic_status, claim.epistemic_status):
                        existing.epistemic_status = "HYPOTHESIS"
                        existing.confidence = min(existing.confidence, claim.confidence)
                    log.info(
                        "ledger: dropped a repeat of %r from %s",
                        claim.text[:60], claim.speaker_role,
                    )
                    return existing

        self.claims[claim.id] = claim
        store.save(claim, self.channel)
        return claim

    def upsert_entity(self, entity: Entity) -> Entity:
        self.entities[entity.id] = entity
        store.save(entity, self.channel)
        return entity

    def upsert_link(self, link: Link) -> Link:
        self.links[link.id] = link
        store.save(link, self.channel)
        return link

    def upsert_unchecked(self, item: Unchecked) -> Unchecked:
        self.unchecked[item.id] = item
        store.save(item, self.channel)
        return item

    def upsert_task(self, task: Task) -> Task:
        self.tasks[task.id] = task
        store.save(task, self.channel)
        return task

    def upsert_contradiction(self, cx: Contradiction) -> Contradiction:
        self.contradictions[cx.id] = cx
        store.save(cx, self.channel)
        return cx

    def add_timeline(self, event: TimelineEvent) -> TimelineEvent:
        self.timeline.append(event)
        self.timeline.sort(key=lambda e: e.at)
        store.save(event, self.channel)
        return event

    async def restore(self) -> int:
        """
        Rehydrate this Ledger from Postgres. Returns the number of rows read.

        ── WHY A RESTART SHOULD NOT LOSE THE INCIDENT ──────────────────────
        The Ledger is the record. Restarting the Slow Loop mid-bridge used to
        erase every claim while the humans were still talking, and there was
        no way to review an incident afterwards — which is most of what an
        incident record is for.

        Rows are constructed by keyword from the column names, which match the
        dataclass fields exactly. A column the model no longer has is dropped
        rather than raising: a schema slightly ahead of the code must not stop
        the service from starting.
        """
        rows = await store.load(self.channel)
        if not rows:
            return 0

        def build(cls, payload: dict) -> object | None:
            names = {f.name for f in dataclass_fields(cls)}
            try:
                return cls(**{k: v for k, v in payload.items() if k in names})
            except Exception:
                log.warning("ledger: skipped an unreadable %s row", cls.__name__)
                return None

        count = 0
        for row in rows.get("entities", []):
            e = build(Entity, row)
            if e: self.entities[e.id] = e; count += 1
        for row in rows.get("links", []):
            l = build(Link, row)
            if l: self.links[l.id] = l; count += 1
        for row in rows.get("claims", []):
            c = build(Claim, row)
            if c: self.claims[c.id] = c; count += 1
        for row in rows.get("unchecked", []):
            u = build(Unchecked, row)
            if u: self.unchecked[u.id] = u; count += 1
        for row in rows.get("tasks", []):
            t = build(Task, row)
            if t: self.tasks[t.id] = t; count += 1
        for row in rows.get("contradictions", []):
            x = build(Contradiction, row)
            if x: self.contradictions[x.id] = x; count += 1
        for row in rows.get("timeline", []):
            ev = build(TimelineEvent, row)
            if ev: self.timeline.append(ev); count += 1
        self.timeline.sort(key=lambda e: e.at)

        return count

    # -- projections (mirror of the frontend selectors) --------------------

    def established(self) -> list[Claim]:
        """Claims Echo may state aloud, with attribution."""
        return [
            c for c in self.claims.values()
            if c.epistemic_status in ("OBSERVED", "TOOL_RESULT")
        ]

    def hypotheses(self) -> list[Claim]:
        return [c for c in self.claims.values() if c.epistemic_status == "HYPOTHESIS"]

    def inferences(self) -> list[Claim]:
        """Dashboard-only. The Bridge Controller filters these out of every payload."""
        return [c for c in self.claims.values() if c.epistemic_status == "INFERRED"]

    def superseded_ids(self) -> set[str]:
        return {c.supersedes for c in self.claims.values() if c.supersedes}

    def open_hypotheses(self) -> list[Claim]:
        settled = self.superseded_ids()
        return [c for c in self.hypotheses() if c.id not in settled]

    def open_unchecked(self) -> list[Unchecked]:
        settled = self.superseded_ids()
        return [u for u in self.unchecked.values() if u.id not in settled]

    def open_contradictions(self) -> list[Contradiction]:
        return [c for c in self.contradictions.values() if not c.resolved]

    def open_tasks(self) -> list[Task]:
        return [t for t in self.tasks.values() if t.status != "DONE"]

    def claims_about(self, entity: str) -> list[Claim]:
        return [c for c in self.claims.values() if c.entity == entity]

    def recap(self, max_claims: int = 12) -> str:
        """
        A compact, plain-text summary of the incident so far.

        ── WHY THIS EXISTS: CONTEXT SURVIVES THE AGENT, THE AGENT DOES NOT ──
        Agora fixes `remote_rtc_uids` at creation, so admitting a new speaker
        means building a NEW agent — and a new agent starts with an empty
        `max_history`. Everything said before it existed is gone from its
        working memory, so the third person to join could ask "what did we
        just establish?" and be told nothing had been.

        The Ledger is the durable record and outlives every agent, so a
        replacement is handed this recap in its system prompt and resumes
        mid-incident instead of starting cold.

        Deliberately ATTRIBUTED and deliberately NOT diagnostic: it repeats
        who said what, never what it means. Feeding an unsourced summary into
        the prompt would let the model treat it as its own knowledge, which is
        exactly the failure §6 exists to prevent.
        """
        if not self.claims and not self.timeline:
            return ""

        lines: list[str] = []

        claims = sorted(self.claims.values(), key=lambda c: c.at)[-max_claims:]
        if claims:
            lines.append("Already on the record (most recent last):")
            for c in claims:
                status = getattr(c, "epistemic_status", "") or ""
                # INFERRED claims never enter a prompt — §6.2 Rule 3. They are
                # the model's own guesses and must not return to it as fact.
                if status == "INFERRED":
                    continue
                who = getattr(c, "speaker_role", None) or "someone"
                lines.append(f"  - {who} said: {c.text}")

        unchecked = [u for u in self.open_unchecked()][:5]
        if unchecked:
            lines.append("Nobody has verified:")
            for u in unchecked:
                lines.append(f"  - {u.text}")

        return chr(10).join(lines)

    # -- the read the Fast Loop's tool hits (§5.2) -------------------------

    def query(self, scope: str, entity: str | None = None) -> dict:
        """
        Deterministic read, NO LLM in the path.

        This is what makes "ask eight times, get eight identical answers" a
        structural property rather than a hope about model stability. The model
        phrases the answer; it does not source it.
        """
        if scope == "entity" and entity:
            e = self.entities.get(entity)
            return {
                "entity": e.to_wire() if e else None,
                "claims": [c.to_wire() for c in self.claims_about(entity)],
                "openTasks": [t.to_wire() for t in self.open_tasks() if t.status != "DONE"],
                "unchecked": [u.to_wire() for u in self.open_unchecked()],
            }

        if scope == "unresolved":
            return {
                "openHypotheses": [c.to_wire() for c in self.open_hypotheses()],
                "unchecked": [u.to_wire() for u in self.open_unchecked()],
                "openTasks": [t.to_wire() for t in self.open_tasks()],
                "unresolvedContradictions": [
                    c.to_wire() for c in self.open_contradictions()
                ],
            }

        if scope == "contradictions":
            return {"contradictions": [c.to_wire() for c in self.contradictions.values()]}

        if scope == "open_tasks":
            return {"openTasks": [t.to_wire() for t in self.open_tasks()]}

        return {
            "phase": self.phase,
            "entities": [e.to_wire() for e in self.entities.values()],
            "established": [c.to_wire() for c in self.established()],
            "openHypotheses": [c.to_wire() for c in self.open_hypotheses()],
            "unchecked": [u.to_wire() for u in self.open_unchecked()],
            "openTasks": [t.to_wire() for t in self.open_tasks()],
        }

    def snapshot(self) -> dict:
        """Full state for a HELLO handshake (§9.3)."""
        return {
            "entities": [e.to_wire() for e in self.entities.values()],
            "links": [l.to_wire() for l in self.links.values()],
            "claims": [c.to_wire() for c in self.claims.values()],
            "unchecked": [u.to_wire() for u in self.unchecked.values()],
            "tasks": [t.to_wire() for t in self.tasks.values()],
            "contradictions": [c.to_wire() for c in self.contradictions.values()],
            "timeline": [t.to_wire() for t in self.timeline],
            "rti": self.rti,
            "phase": self.phase,
        }
