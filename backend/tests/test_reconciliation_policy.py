"""
Unit tests for the EntityReconciler domain policy.
"""

from __future__ import annotations

import unittest

from app.core.policies.reconciliation import EntityReconciler, VAGUE_NOUNS


class TestEntityReconcilerPolicy(unittest.TestCase):

    def test_canonical_alias_maps_to_existing_id(self):
        known = {"redis": "e2", "primary-redis": "e2", "checkout": "e1"}
        reconciler = EntityReconciler(known)

        raw = {"id": "cache", "label": "Redis", "kind": "datastore"}
        entity = reconciler.reconcile_entity(raw)

        self.assertEqual(entity.id, "e2")
        self.assertEqual(entity.label, "Redis")
        self.assertEqual(reconciler.renamed["cache"], "e2")
        self.assertEqual(reconciler.reindex("cache"), "e2")

    def test_unspecified_promoted_when_label_names_specific_system(self):
        reconciler = EntityReconciler({})

        raw = {"id": "database-unspecified", "label": "Postgres Primary", "kind": "datastore"}
        entity = reconciler.reconcile_entity(raw)

        self.assertEqual(entity.id, "postgres-primary")
        self.assertEqual(entity.label, "Postgres Primary")
        self.assertEqual(reconciler.reindex("database-unspecified"), "postgres-primary")

    def test_vague_nouns_are_not_promoted(self):
        reconciler = EntityReconciler({})

        for noun in ["database", "the database", "cache", "the service", "queue", "system"]:
            raw = {"id": "database-unspecified", "label": noun, "kind": "service"}
            entity = reconciler.reconcile_entity(raw)
            self.assertEqual(entity.id, "database-unspecified")
            self.assertEqual(reconciler.reindex("database-unspecified"), "database-unspecified")

    def test_reindex_leaves_unmutated_ids_untouched(self):
        reconciler = EntityReconciler({"redis": "e2"})
        self.assertEqual(reconciler.reindex("checkout-service"), "checkout-service")
        self.assertEqual(reconciler.reindex(""), "")
        self.assertEqual(reconciler.reindex(None), "")

    def test_link_endpoints_reindexed_correctly(self):
        known = {"redis": "e2"}
        reconciler = EntityReconciler(known)

        # Entity 'cache' maps to 'e2'
        reconciler.reconcile_entity({"id": "cache", "label": "Redis"})
        # Entity 'database-unspecified' promotes to 'postgres-replica'
        reconciler.reconcile_entity({"id": "database-unspecified", "label": "Postgres Replica"})

        self.assertEqual(reconciler.reindex("cache"), "e2")
        self.assertEqual(reconciler.reindex("database-unspecified"), "postgres-replica")
        self.assertEqual(reconciler.reindex("checkout"), "checkout")


if __name__ == "__main__":
    unittest.main()
