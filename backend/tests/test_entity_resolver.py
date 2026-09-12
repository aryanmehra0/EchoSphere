import os
import unittest
from unittest import mock

from app.domain.entity_resolver import CanonicalEntityResolver
from app.domain.models import Claim
from app.domain.policies.contradiction import ContradictionEngine


class TestEntityResolver(unittest.TestCase):
    def test_canonical_clustering(self) -> None:
        self.assertTrue(CanonicalEntityResolver.are_synonyms("redis", "cache"))
        self.assertTrue(CanonicalEntityResolver.are_synonyms("redis-primary", "the-cache"))
        self.assertTrue(CanonicalEntityResolver.are_synonyms("postgres", "database"))
        self.assertTrue(CanonicalEntityResolver.are_synonyms("db", "postgres-primary"))
        self.assertTrue(CanonicalEntityResolver.are_synonyms("checkout", "cart"))

        # Distinct systems are NOT synonyms
        self.assertFalse(CanonicalEntityResolver.are_synonyms("redis", "postgres"))
        self.assertFalse(CanonicalEntityResolver.are_synonyms("checkout", "kafka"))

    def test_hierarchical_entity_paths(self) -> None:
        self.assertTrue(CanonicalEntityResolver.are_synonyms("service/database/primary", "postgres"))
        self.assertTrue(CanonicalEntityResolver.are_synonyms("prod-redis-cache", "redis"))

    def test_a_service_owned_datastore_resolves_to_the_datastore_not_the_owner(self) -> None:
        """
        Regression: `canonical_id` scanned a hierarchical path's segments
        left-to-right, so "checkout-db" resolved to "cart" (the checkout/cart
        cluster) because "checkout" is itself a cluster member and matched
        before "db" was ever checked — contradicting this module's own
        documented example ("service/db/primary" -> "db") and silently
        merging a service with its database for contradiction scoping.
        """
        self.assertEqual(CanonicalEntityResolver.canonical_id("checkout-db"), "db")
        self.assertFalse(CanonicalEntityResolver.are_synonyms("checkout-db", "checkout"))
        self.assertTrue(CanonicalEntityResolver.are_synonyms("checkout-db", "postgres"))

    def test_custom_aliases_resolution(self) -> None:
        custom = {"the-shard": "datastore-1"}
        self.assertTrue(CanonicalEntityResolver.are_synonyms("the-shard", "datastore-1", custom))

    def test_built_in_clusters_can_be_disabled_for_a_real_deployment(self) -> None:
        """
        A real organization's `queue` (say, SQS) and `kafka` are routinely
        two distinct systems, not the demo topology's synonym cluster. With
        `ENTITY_SYNONYM_CLUSTERS=off`, built-in clustering must not merge
        them — while a per-session `custom_aliases` declaration (the
        deployment's own, actual equivalences) still works.
        """
        with mock.patch.dict(os.environ, {"ENTITY_SYNONYM_CLUSTERS": "off"}):
            self.assertFalse(CanonicalEntityResolver.are_synonyms("queue", "kafka"))
            self.assertFalse(CanonicalEntityResolver.are_synonyms("redis", "cache"))
            self.assertEqual(CanonicalEntityResolver.canonical_id("redis-cluster"), "redis-cluster")
            # Exact-match and custom aliases are untouched by the flag.
            self.assertTrue(CanonicalEntityResolver.are_synonyms("redis", "redis"))
            custom = {"queue-1": "kafka-1"}
            self.assertTrue(CanonicalEntityResolver.are_synonyms("queue-1", "kafka-1", custom))

    def test_contradiction_scoping_across_synonyms(self) -> None:
        engine = ContradictionEngine()

        # Existing claim uses entity "cache"
        c1 = Claim(
            id="c1",
            text="Memory usage is at 40 percent and stable.",
            epistemic_status="OBSERVED",
            speaker_role="DevOps Lead",
            confidence=0.9,
            entity="cache",
            at=10000,
        )

        # New claim uses entity "redis-cluster" (an operational synonym)
        c2 = Claim(
            id="c2",
            text="Application logs are showing massive timeouts.",
            epistemic_status="OBSERVED",
            speaker_role="Support Engineer",
            confidence=0.9,
            entity="redis-cluster",
            at=20000,
        )

        # Scoping c2 against existing claims [c1]
        scoped = engine.scope(c2, [c1], now_ms_=25000)
        # Because "cache" and "redis-cluster" are recognized synonyms, c1 MUST be in scope
        self.assertEqual(len(scoped), 1)
        self.assertEqual(scoped[0].id, "c1")


if __name__ == "__main__":
    unittest.main()

