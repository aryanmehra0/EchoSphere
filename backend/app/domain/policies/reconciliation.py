"""
Domain policy: Entity Reconciliation.

Encapsulates:
- Canonical alias lookup against established incident entities.
- Promotion of '-unspecified' IDs when a specific system name is spoken.
- Protection against promoting vague infrastructure nouns into fake system IDs.
- Tracking remapped IDs within an extraction window to re-index links and claims.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..models import Entity

log = logging.getLogger("echo.core.reconciliation")

VAGUE_NOUNS: frozenset[str] = frozenset({
    "database", "the-database", "a-database", "db", "the-db",
    "cache", "the-cache", "service", "the-service",
    "server", "the-server", "queue", "the-queue",
    "network", "the-network", "system", "the-system",
    "api", "the-api", "app", "the-app",
})


class VagueNounPolicy:
    """Shields generic infrastructure terms from being treated as specific system IDs."""

    VAGUE_NOUNS = VAGUE_NOUNS

    @staticmethod
    def is_vague(noun: str) -> bool:
        return noun.lower().strip() in VAGUE_NOUNS


class EntityReconciler:
    """
    Stateful reconciler scoped to a single extraction window.

    Translates raw entity dictionaries emitted by the extraction model into
    reconciled `Entity` domain objects, and maintains a `renamed` mapping so
    that links and claims referencing the model's original proposed IDs are
    rewritten to the reconciled IDs.
    """

    def __init__(self, known_aliases: dict[str, str]) -> None:
        self._known_aliases = known_aliases
        self._renamed: dict[str, str] = {}

    @property
    def renamed(self) -> dict[str, str]:
        """Map of original proposed_id -> resolved_id for this window."""
        return self._renamed

    def reconcile_entity(self, raw_entity: dict[str, Any]) -> Entity:
        """
        Produce a canonical Entity from an extraction row.
        Remaps IDs if an alias already exists or if an -unspecified ID can be promoted.
        """
        proposed_id = str(raw_entity["id"])
        label = str(raw_entity.get("label", raw_entity["id"]))
        aliases = [str(a) for a in (raw_entity.get("aliases") or [])]
        kind = raw_entity.get("kind", "service")
        status = raw_entity.get("status", "UNKNOWN")

        resolved_id = proposed_id

        # 1. Direct alias match
        for candidate in (proposed_id, label, *aliases):
            lower_cand = candidate.lower()
            if lower_cand in self._known_aliases:
                resolved_id = self._known_aliases[lower_cand]
                break

        # 2. Promotion of '-unspecified' if label carries a concrete name
        if resolved_id.endswith("-unspecified"):
            slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
            if slug and slug not in VAGUE_NOUNS:
                resolved_id = slug
                log.info(
                    "reconciler: promoted entity %r -> %r (label %r names a system)",
                    proposed_id,
                    resolved_id,
                    label,
                )

        if resolved_id != proposed_id:
            self._renamed[proposed_id] = resolved_id

        return Entity(
            id=resolved_id,
            label=label,
            aliases=aliases,
            kind=kind,
            status=status,
            detail=raw_entity.get("detail", ""),
            metric=raw_entity.get("metric"),
            position=raw_entity.get("position"),
        )

    def reindex(self, entity_id: str | None) -> str:
        """Remap an entity ID if it was renamed during this window."""
        if not entity_id:
            return ""
        return self._renamed.get(entity_id, entity_id)
