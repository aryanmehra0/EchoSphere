"""
Entity resolution — the join that must NOT be left to the model.

Every test here comes from a live failure: extraction tagged one claim `e2` and
left another with no entity at all, so contradiction scoping found zero
candidates and the headline feature silently never fired.
"""

from __future__ import annotations

import unittest

from app.extraction import entity_aliases, resolve_entities
from app.ledger import Ledger
from app.models import Entity


ENTITIES = [
    {"id": "e1", "label": "checkout", "kind": "service"},
    {"id": "e2", "label": "Redis Primary", "kind": "datastore"},
]


class TestResolveEntities(unittest.TestCase):

    def test_a_claim_with_no_entity_is_matched_by_its_text(self):
        # THE bug: "Memory is at 40 percent" arrived with entity "" and was
        # therefore never a contradiction candidate.
        claims = [{"id": "c1", "text": "Redis memory is at 40 percent", "entity": ""}]
        out = resolve_entities(claims, ENTITIES)
        self.assertEqual(out[0]["entity"], "e2")

    def test_a_model_supplied_id_that_we_recognise_is_kept(self):
        claims = [{"id": "c1", "text": "cache read timeouts", "entity": "e2"}]
        self.assertEqual(resolve_entities(claims, ENTITIES)[0]["entity"], "e2")

    def test_two_claims_about_one_entity_end_up_with_the_SAME_id(self):
        # This is the property contradiction scoping actually depends on.
        claims = [
            {"id": "c1", "text": "Redis memory is at 40 percent", "entity": ""},
            {"id": "c2", "text": "Redis cache read timeouts observed", "entity": "e2"},
        ]
        out = resolve_entities(claims, ENTITIES)
        self.assertEqual(out[0]["entity"], out[1]["entity"])

    def test_a_label_word_matches(self):
        # "Redis Primary" should also catch a claim that just says "redis".
        claims = [{"id": "c1", "text": "redis looks healthy", "entity": ""}]
        self.assertEqual(resolve_entities(claims, ENTITIES)[0]["entity"], "e2")

    def test_an_unmatched_claim_is_left_UNSET_not_guessed(self):
        # Guessing would compare claims about different systems, which is the
        # G4 row-4 false positive. No entity means no candidate — safe.
        claims = [{"id": "c1", "text": "tickets are flooding in", "entity": ""}]
        out = resolve_entities(claims, ENTITIES)
        self.assertNotIn("entity", out[0])

    def test_the_longest_alias_wins(self):
        ents = [
            {"id": "redis", "label": "Redis"},
            {"id": "redis-replica", "label": "Redis Replica"},
        ]
        claims = [{"id": "c1", "text": "the redis replica was promoted", "entity": ""}]
        self.assertEqual(resolve_entities(claims, ents)[0]["entity"], "redis-replica")

    def test_aliases_carry_ACROSS_windows(self):
        # Without this, ids drift every flush: "Redis" becomes e2 in one window
        # and e5 in the next, and scoping breaks a different way.
        led = Ledger()
        led.upsert_entity(Entity(id="e2", label="Redis Primary", kind="datastore", status="WARNING"))

        # A later window that mentions Redis but declares no entities at all.
        claims = [{"id": "c9", "text": "Redis memory climbing", "entity": ""}]
        out = resolve_entities(claims, [], entity_aliases(led))
        self.assertEqual(out[0]["entity"], "e2")


class TestIdStabilityAcrossWindows(unittest.TestCase):
    """
    The precedence bug that silently disabled the headline feature.

    Window 1 named checkout `e1` and Redis `e2`. Window 3 proposed `checkout`
    and `cache` for the SAME two systems. With the fresh window winning, claims
    about one system split across two ids, Stage 0 found no candidates, and the
    contradiction never fired — while the dashboard showed four nodes for two
    real things.
    """

    def test_an_established_id_beats_a_fresh_proposal_for_the_same_label(self):
        known = {"redis": "e2", "checkout": "e1"}
        fresh = [{"id": "cache", "label": "cache"}, {"id": "checkout", "label": "checkout"}]

        claims = [{"id": "c1", "text": "checkout is returning 500s", "entity": "checkout"}]
        out = resolve_entities(claims, fresh, known)
        self.assertEqual(out[0]["entity"], "e1", "a fresh window renamed an established entity")

    def test_two_windows_describing_one_system_converge_on_one_id(self):
        # The property contradiction scoping actually needs.
        known = {"redis": "e2"}
        w3_entities = [{"id": "cache", "label": "cache"}]

        a = resolve_entities(
            [{"id": "c1", "text": "Redis memory is at 40 percent", "entity": ""}],
            [{"id": "e2", "label": "Redis"}], known,
        )
        b = resolve_entities(
            [{"id": "c2", "text": "Redis read timeouts observed", "entity": "cache"}],
            w3_entities, known,
        )
        # c2's model-supplied "cache" is unknown, so it falls through to text
        # matching and finds "redis" -> e2, the same id c1 got.
        self.assertEqual(a[0]["entity"], "e2")
        self.assertEqual(b[0]["entity"], "e2")


class TestEntityAliases(unittest.TestCase):

    def test_ids_labels_and_label_words_are_all_aliases(self):
        led = Ledger()
        led.upsert_entity(Entity(id="e2", label="Redis Primary", kind="datastore", status="OK"))
        aliases = entity_aliases(led)

        self.assertEqual(aliases["e2"], "e2")
        self.assertEqual(aliases["redis primary"], "e2")
        self.assertEqual(aliases["redis"], "e2")

    def test_short_words_are_not_aliased(self):
        # "the", "of" would match everything.
        led = Ledger()
        led.upsert_entity(Entity(id="e1", label="API of the West", kind="service", status="OK"))
        aliases = entity_aliases(led)
        self.assertNotIn("the", aliases)
        self.assertNotIn("of", aliases)


if __name__ == "__main__":
    unittest.main()


class EntityUpsertMergesRatherThanClobbers(unittest.TestCase):
    """
    Reported live, two symptoms with one cause.

    `upsert_entity` was `self.entities[id] = entity` — a wholesale overwrite.
    So every window that mentioned a system replaced everything the previous
    window knew about it:

      - a graph node displayed `95%` while the database column was EMPTY: the
        metric was set by one window and blanked by the next, which mentioned
        the same system without restating the number;
      - `status` stayed CRITICAL after "Redis is not down right now", because
        the correcting window proposed no status and the stale value survived
        by accident.

    The rule these pin: a later window may UPDATE a field, but SILENCE IS NOT
    AN UPDATE.
    """

    def setUp(self):
        from app.ledger import Ledger
        self.led = Ledger()

    def _ent(self, **over):
        from app.models import Entity
        base = dict(id="redis", label="Redis", kind="datastore", status="CRITICAL")
        base.update(over)
        return Entity(**base)

    def test_a_metric_is_not_blanked_by_a_window_that_omits_it(self):
        self.led.upsert_entity(self._ent(metric="95%"))
        # Second window mentions Redis but restates no number. The model
        # returns "" rather than None here, which is why the guard is falsy
        # rather than `is None`.
        self.led.upsert_entity(self._ent(metric=""))
        self.assertEqual(self.led.entities["redis"].metric, "95%")

    def test_UNKNOWN_does_not_overwrite_a_real_status(self):
        self.led.upsert_entity(self._ent(status="CRITICAL"))
        self.led.upsert_entity(self._ent(status="UNKNOWN"))
        self.assertEqual(self.led.entities["redis"].status, "CRITICAL")

    def test_but_a_REAL_status_change_still_lands(self):
        """
        The merge must not freeze the graph. "Redis is not down right now"
        genuinely revises CRITICAL to OK, and extraction does emit that.
        """
        self.led.upsert_entity(self._ent(status="CRITICAL"))
        self.led.upsert_entity(self._ent(status="OK"))
        self.assertEqual(self.led.entities["redis"].status, "OK")

    def test_aliases_accumulate_instead_of_being_replaced(self):
        """
        The alias table is what makes "the cache" resolve to Redis across
        windows. Dropping earlier synonyms is what once split one system
        across two ids and silently disabled contradiction detection.
        """
        self.led.upsert_entity(self._ent(aliases=["Redis", "the cache"]))
        self.led.upsert_entity(self._ent(aliases=["the shard"]))
        got = {a.lower() for a in self.led.entities["redis"].aliases}
        self.assertEqual(got, {"redis", "the cache", "the shard"})

    def test_a_first_write_is_unchanged(self):
        self.led.upsert_entity(self._ent(status="OK", metric="40%"))
        e = self.led.entities["redis"]
        self.assertEqual((e.status, e.metric), ("OK", "40%"))
