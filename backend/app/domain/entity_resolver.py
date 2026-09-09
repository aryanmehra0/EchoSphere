"""
Canonical Entity Resolver and Hierarchical Topology — Phase 5 P4.

Ensures that operational synonyms ("cache" vs "redis", "postgres" vs "database")
and hierarchical entity paths ("checkout/db/primary") are deterministically
mapped to canonical entities, preventing missed contradictions when engineers
use alternate names for the same subsystem.
"""

from __future__ import annotations

import re
from typing import Iterable


# Canonical clusters of IT operations synonyms
_SYNONYM_CLUSTERS: list[set[str]] = [
    {
        "redis",
        "cache",
        "redis-cache",
        "redis-primary",
        "redis-cluster",
        "the-cache",
        "the-shard",
        "cache-cluster",
        "shard",
    },
    {
        "postgres",
        "database",
        "db",
        "postgres-primary",
        "postgres-replica",
        "patroni",
        "pg-cluster",
        "primary-db",
        "replica-db",
        "database-unspecified",
    },
    {
        "checkout",
        "cart",
        "checkout-service",
        "order-service",
        "order-api",
        "checkout-api",
    },
    {
        "kafka",
        "queue",
        "event-bus",
        "message-queue",
        "broker",
        "pubsub",
    },
    {
        "network",
        "vpc",
        "gateway",
        "load-balancer",
        "ingress",
        "dns",
    },
]

# Fast lookup from normalized token to cluster canonical root
_CANONICAL_LOOKUP: dict[str, str] = {}
for cluster in _SYNONYM_CLUSTERS:
    # First item is the canonical anchor
    sorted_cluster = sorted(cluster, key=lambda s: (len(s), s))
    anchor = sorted_cluster[0]
    for item in cluster:
        _CANONICAL_LOOKUP[item] = anchor


def _normalize_id(entity_id: str | None) -> str:
    """Normalize whitespace, underscores, hyphens, and slashes."""
    if not entity_id:
        return ""
    clean = re.sub(r"[_\s./]+", "-", entity_id.strip().lower())
    return re.sub(r"-+", "-", clean).strip("-")


class CanonicalEntityResolver:
    """Deterministic alias matching and hierarchical entity resolution."""

    @staticmethod
    def canonical_id(entity_id: str | None) -> str:
        """
        Return the canonical root identifier for an entity.
        Handles hierarchical paths like 'service/db/primary' -> 'db'.
        """
        norm = _normalize_id(entity_id)
        if not norm:
            return ""

        # Direct cluster lookup
        if norm in _CANONICAL_LOOKUP:
            return _CANONICAL_LOOKUP[norm]

        # Check each segment in a hierarchical identifier
        segments = norm.split("-")
        for seg in segments:
            if seg in _CANONICAL_LOOKUP:
                return _CANONICAL_LOOKUP[seg]

        return norm

    @classmethod
    def are_synonyms(
        cls,
        entity_a: str | None,
        entity_b: str | None,
        custom_aliases: dict[str, str] | None = None,
    ) -> bool:
        """
        Determine if two entity IDs refer to the same logical subsystem.
        """
        if not entity_a or not entity_b:
            return False

        norm_a = _normalize_id(entity_a)
        norm_b = _normalize_id(entity_b)

        if norm_a == norm_b:
            return True

        # Check built-in cluster lookup
        can_a = cls.canonical_id(norm_a)
        can_b = cls.canonical_id(norm_b)
        if can_a and can_b and can_a == can_b:
            return True

        # Check custom session aliases if supplied
        if custom_aliases:
            ca_a = custom_aliases.get(norm_a) or custom_aliases.get(entity_a)
            ca_b = custom_aliases.get(norm_b) or custom_aliases.get(entity_b)
            if ca_a and ca_b and ca_a == ca_b:
                return True
            if ca_a and ca_a == entity_b:
                return True
            if ca_b and ca_b == entity_a:
                return True

        return False

    @classmethod
    def find_synonyms(cls, entity_id: str | None) -> set[str]:
        """Return all known synonyms for a given entity."""
        can = cls.canonical_id(entity_id)
        if not can:
            return set()
        return {k for k, v in _CANONICAL_LOOKUP.items() if v == can}

