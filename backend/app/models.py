"""
The data contract — v6 §9.4.

These mirror `frontend/src/lib/types.ts` field for field. That is not tidiness:
the Delta Hub serialises these straight onto the dashboard socket, and the
frontend reducer merges them with no adapter layer. A field added here must be
added there, and vice versa.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

EpistemicStatus = Literal["OBSERVED", "TOOL_RESULT", "HYPOTHESIS", "INFERRED"]
EntityStatus = Literal["CRITICAL", "WARNING", "OK", "UNKNOWN"]
EntityKind = Literal["service", "datastore", "network", "gateway", "region", "client"]
EdgeKind = Literal["causal", "suspected", "depends"]
TaskStatus = Literal["OPEN", "IN_PROGRESS", "BLOCKED", "DONE"]
TimelineKind = Literal["signal", "decision", "action", "contradiction", "resolution"]


def now_ms() -> int:
    return int(time.time() * 1000)


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    """Drop None values so deltas stay small and the reducer's merge is additive."""
    return {k: v for k, v in d.items() if v is not None}


# ---------------------------------------------------------------------------
# Enum coercion — the wire is fed by an LLM now
# ---------------------------------------------------------------------------

ENTITY_KINDS = ("service", "datastore", "network", "gateway", "region", "client")
ENTITY_STATUSES = ("CRITICAL", "WARNING", "OK", "UNKNOWN")
EDGE_KINDS = ("causal", "suspected", "depends")
TASK_STATUSES = ("OPEN", "IN_PROGRESS", "BLOCKED", "DONE")
TIMELINE_KINDS = ("signal", "decision", "action", "contradiction", "resolution")


def coerce(value: Any, allowed: tuple[str, ...], fallback: str) -> str:
    """
    Force a value into the union the frontend expects.

    ── WHY THIS IS NOT PARANOIA ────────────────────────────────────────────
    The dashboard renders enums through lookup tables — `GLYPH[entity.kind]`,
    `KIND[event.kind]`. A value outside the union yields `undefined`, and the
    component throws while rendering. React unmounts the tree and the operator
    gets a blank console.

    That is exactly what happened live: extraction emitted an entity kind
    outside the six allowed values, and the whole dashboard went white while
    the backend sat there perfectly healthy with a correct Ledger. Before the
    LLM fed this wire, the contract was written by hand and could be trusted.
    It cannot be any more.

    Coercing to a safe member is better than dropping the row: an entity shown
    with the wrong glyph is a cosmetic error, an entity missing from the graph
    is a hole in the incident record.
    ────────────────────────────────────────────────────────────────────────
    """
    text = str(value or "").strip()
    if text in allowed:
        return text
    # Case-insensitive rescue before giving up — models love "Service".
    for member in allowed:
        if text.lower() == member.lower():
            return member
    return fallback


@dataclass
class Claim:
    """
    The unit of record — v6 §6.1.

    `epistemic_status` is the load-bearing field of the whole architecture. It
    is what turns "is this a fact or an assumption?" into a QUERY rather than a
    convention that two separate arrays happen to follow.

    `speaker_role` is mandatory. §6.2 Rule 1: a claim without a source is not
    sayable, so one must never be constructible without attribution.
    """

    id: str
    text: str
    epistemic_status: EpistemicStatus
    speaker_role: str
    confidence: float
    at: int = field(default_factory=now_ms)
    entity: str | None = None
    supersedes: str | None = None
    contradicts: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.speaker_role or not self.speaker_role.strip():
            raise ValueError(
                f"Claim {self.id} has no speaker_role. "
                "v6 §6.2 Rule 1: a claim without a source is not sayable."
            )

    def to_wire(self) -> dict[str, Any]:
        return _clean({
            "id": self.id,
            "text": self.text,
            "entity": self.entity,
            "epistemicStatus": self.epistemic_status,
            "speakerRole": self.speaker_role,
            "confidence": self.confidence,
            "at": self.at,
            "supersedes": self.supersedes,
            "contradicts": self.contradicts or None,
        })


@dataclass
class Unchecked:
    """What the conversation has NOT established — requirement 5's quiet half."""

    id: str
    description: str
    at: int = field(default_factory=now_ms)
    suggested_owner: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return _clean({
            "id": self.id,
            "description": self.description,
            "suggestedOwner": self.suggested_owner,
            "at": self.at,
        })


@dataclass
class Entity:
    id: str
    label: str
    kind: EntityKind
    status: EntityStatus
    detail: str | None = None
    metric: str | None = None
    position: dict[str, float] | None = None
    # Other words the room uses for this same system ("the cache" for Redis).
    # Carried on the entity so the alias table survives across windows.
    aliases: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        # The graph renders `GLYPH[kind]`; an unknown kind blanks the dashboard.
        self.kind = coerce(self.kind, ENTITY_KINDS, "service")  # type: ignore[assignment]
        self.status = coerce(self.status, ENTITY_STATUSES, "UNKNOWN")  # type: ignore[assignment]

    def to_wire(self) -> dict[str, Any]:
        return _clean(asdict(self))


@dataclass
class Link:
    id: str
    source: str
    target: str
    label: str
    kind: EdgeKind

    def __post_init__(self) -> None:
        self.kind = coerce(self.kind, EDGE_KINDS, "suspected")  # type: ignore[assignment]

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Task:
    id: str
    assignee_role: str
    description: str
    status: TaskStatus
    at: int = field(default_factory=now_ms)
    evidence: list[str] = field(default_factory=list)
    ref: str | None = None

    def __post_init__(self) -> None:
        self.status = coerce(self.status, TASK_STATUSES, "OPEN")  # type: ignore[assignment]

    def to_wire(self) -> dict[str, Any]:
        return _clean({
            "id": self.id,
            "assigneeRole": self.assignee_role,
            "description": self.description,
            "status": self.status,
            "evidence": self.evidence or None,
            "ref": self.ref,
            "at": self.at,
        })


@dataclass
class Contradiction:
    id: str
    claim_a: str
    claim_b: str
    speakers: list[str]
    at: int = field(default_factory=now_ms)
    resolved: bool = False
    # The adjudicator's verdict (§7.1). Kept for the audit trail even when the
    # relation is not OPPOSED, because "these two were conflated" is itself a
    # finding worth surfacing.
    relation: str | None = None
    why: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return _clean({
            "id": self.id,
            "claimA": self.claim_a,
            "claimB": self.claim_b,
            "speakers": self.speakers,
            "resolved": self.resolved,
            "at": self.at,
        })


@dataclass
class TimelineEvent:
    id: str
    kind: TimelineKind
    text: str
    actor: str
    at: int = field(default_factory=now_ms)

    def __post_init__(self) -> None:
        # TimelinePanel renders `KIND[kind].icon`; unknown -> undefined -> throw.
        self.kind = coerce(self.kind, TIMELINE_KINDS, "signal")  # type: ignore[assignment]

    def to_wire(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Transcript:
    """One role-attributed utterance from the Observer."""

    message_id: str
    uid: int
    role: str
    text: str
    is_final: bool
    at: int = field(default_factory=now_ms)

    def to_wire(self) -> dict[str, Any]:
        return {
            "messageId": self.message_id,
            "uid": self.uid,
            "role": self.role,
            "text": self.text,
            "isFinal": self.is_final,
            "at": self.at,
        }
