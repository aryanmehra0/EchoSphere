import unittest

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

    def test_custom_aliases_resolution(self) -> None:
        custom = {"the-shard": "datastore-1"}
        self.assertTrue(CanonicalEntityResolver.are_synonyms("the-shard", "datastore-1", custom))

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

