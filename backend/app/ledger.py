"""
The Evidence Ledger — v6 §6, §9.1.

One claim table discriminated by `epistemic_status`, not separate fact and
hypothesis arrays. That is what makes the fact-versus-assumption separation the
problem statement demands a QUERY rather than a convention.

Mirrors the selectors in `frontend/src/lib/incident-reducer.ts` so both sides of
the wire answer the same questions the same way.
"""

from __future__ import annotations

from dataclasses import dataclass, field

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
        self.claims[claim.id] = claim
        return claim

    def upsert_entity(self, entity: Entity) -> Entity:
        self.entities[entity.id] = entity
        return entity

    def upsert_link(self, link: Link) -> Link:
        self.links[link.id] = link
        return link

    def upsert_unchecked(self, item: Unchecked) -> Unchecked:
        self.unchecked[item.id] = item
        return item

    def upsert_task(self, task: Task) -> Task:
        self.tasks[task.id] = task
        return task

    def upsert_contradiction(self, cx: Contradiction) -> Contradiction:
        self.contradictions[cx.id] = cx
        return cx

    def add_timeline(self, event: TimelineEvent) -> TimelineEvent:
        self.timeline.append(event)
        self.timeline.sort(key=lambda e: e.at)
        return event

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
