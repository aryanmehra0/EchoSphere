"""
Extraction pipeline — v6 §4.4, §14.2.

The LLM is injected, so these run deterministically with no network. That is
the point of the seam: Rehearsal Rig Tier 2 measures extraction QUALITY against
fixtures, not the vendor's uptime.
"""

from __future__ import annotations

import asyncio
import json
import unittest

from app.extraction import (
    resolve_links,
    ExtractionDropped,
    SchemaError,
    TurnWindow,
    compact,
    extract,
    validate_extraction,
)
from app.ledger import Ledger
from app.models import Claim, Task, Transcript, Unchecked


# The id is derived from (text, role), not text alone. Agora issues one id per
# UTTERANCE, so two engineers independently saying "the cache is fine" carry
# different ids — and a helper that collides them would make dedup look like it
# was erasing a real second speaker.
_UIDS = {"DevOps Lead": 1001, "Support Engineer": 1002, "Database Admin": 1003}


def frame(text: str, role: str = "DevOps Lead", *, final: bool = True) -> Transcript:
    return Transcript(
        message_id=f"m{abs(hash((text, role))) % 999999}",
        uid=_UIDS.get(role, 1001),
        role=role,
        text=text,
        is_final=final,
    )


def run(coro):
    return asyncio.run(coro)


class TestTurnWindow(unittest.TestCase):

    def test_partial_frames_are_not_extracted_from(self):
        # Extracting from a half-spoken sentence produces claims that are wrong
        # and then have to be superseded.
        w = TurnWindow()
        w.add(frame("Memory is at", final=False))
        self.assertEqual(len(w.frames), 0)

        w.add(frame("Memory is at 40 percent", final=True))
        self.assertEqual(len(w.frames), 1)

    def test_flushes_after_silence(self):
        w = TurnWindow()
        w.add(frame("Memory is at 40 percent"))
        self.assertFalse(w.should_flush(now=w.last_final_at + 0.5))
        self.assertTrue(w.should_flush(now=w.last_final_at + 1.6))

    def test_flushes_on_the_elapsed_cap_even_while_someone_keeps_talking(self):
        # A monologue must still produce deltas rather than one huge extraction
        # at the end of it.
        w = TurnWindow()
        w.add(frame("still going"))
        self.assertTrue(w.should_flush(now=w.opened_at + 8.1))

    def test_flushes_on_the_size_cap(self):
        w = TurnWindow()
        w.add(frame("x" * 1700))
        self.assertTrue(w.should_flush(now=w.last_final_at))

    def test_an_empty_window_never_flushes(self):
        self.assertFalse(TurnWindow().should_flush())

    def test_renders_role_attributed_lines(self):
        w = TurnWindow()
        w.add(frame("memory at 40 percent", "DevOps Lead"))
        w.add(frame("read timeouts", "Support Engineer"))
        rendered = w.render()
        self.assertIn("[DevOps Lead] memory at 40 percent", rendered)
        self.assertIn("[Support Engineer] read timeouts", rendered)

    def test_the_same_utterance_twice_is_accepted_once(self):
        """
        The backstop for duplicate delivery.

        RTM does not guarantee once-only delivery, a reconnecting browser can
        replay, and until it was fixed every browser on the channel forwarded
        every speaker's transcript — so a two-machine demo doubled each
        sentence. A duplicate here is not harmless: the Ledger gets two claims
        with different ids for one sentence, and the contradiction engine can
        then adjudicate a sentence against itself.
        """
        w = TurnWindow()
        first = frame("Redis memory is at 40 percent")
        again = frame("Redis memory is at 40 percent")
        again.message_id = first.message_id  # same utterance, forwarded twice

        self.assertTrue(w.add(first))
        self.assertFalse(w.add(again), "a duplicate transcript was accepted")
        self.assertEqual(len(w.frames), 1)

    def test_two_speakers_saying_the_same_words_are_both_kept(self):
        # Dedup is by message id, NOT by text. Two engineers independently
        # reporting "the cache is fine" is a real signal, and collapsing them
        # would erase one person's contribution to the record.
        w = TurnWindow()
        a = frame("The cache is fine", "DevOps Lead")
        b = frame("The cache is fine", "Support Engineer")
        self.assertNotEqual(a.message_id, b.message_id)

        self.assertTrue(w.add(a))
        self.assertTrue(w.add(b))
        self.assertEqual(len(w.frames), 2)

    def test_a_duplicate_after_a_flush_is_still_rejected(self):
        # The window drains, but the incident has still heard that sentence.
        w = TurnWindow()
        f = frame("Memory is at 40 percent")
        w.add(f)
        w.drain()

        repeat = frame("Memory is at 40 percent")
        repeat.message_id = f.message_id
        self.assertFalse(w.add(repeat))

    def test_add_reports_whether_the_frame_was_taken(self):
        w = TurnWindow()
        self.assertTrue(w.add(frame("a final sentence")))
        self.assertFalse(w.add(frame("a partial", final=False)))

    def test_drain_resets_the_window(self):
        w = TurnWindow()
        w.add(frame("a"))
        self.assertEqual(len(w.drain()), 1)
        self.assertEqual(len(w.frames), 0)
        self.assertFalse(w.should_flush())


class TestSchemaValidation(unittest.TestCase):

    def test_missing_keys_become_empty_lists(self):
        out = validate_extraction({"claims": []})
        self.assertEqual(out["entities"], [])
        self.assertEqual(out["unchecked"], [])

    def test_a_non_object_is_rejected(self):
        with self.assertRaises(SchemaError):
            validate_extraction([1, 2, 3])

    def test_a_non_list_field_is_rejected(self):
        with self.assertRaises(SchemaError):
            validate_extraction({"claims": "not a list"})

    def test_an_unsourced_claim_is_DROPPED_not_defaulted(self):
        # §6.2 Rule 1 — inventing "unknown" would launder an unusable claim
        # into a sayable one.
        out = validate_extraction({
            "claims": [
                {"id": "c1", "text": "memory at 40", "speakerRole": "", "epistemicStatus": "OBSERVED"},
                {"id": "c2", "text": "timeouts", "speakerRole": "Support Engineer", "epistemicStatus": "OBSERVED"},
            ]
        })
        self.assertEqual([c["id"] for c in out["claims"]], ["c2"])

    def test_an_unknown_status_is_coerced_to_the_most_cautious_option(self):
        out = validate_extraction({
            "claims": [{"id": "c1", "text": "x", "speakerRole": "DevOps Lead",
                        "epistemicStatus": "PROBABLY"}]
        })
        self.assertEqual(out["claims"][0]["epistemicStatus"], "HYPOTHESIS")


class TestExtractCall(unittest.TestCase):

    def test_a_clean_response_is_parsed(self):
        async def fake(system, user):
            return json.dumps({
                "claims": [{"id": "c1", "text": "memory at 40 percent",
                            "speakerRole": "DevOps Lead", "epistemicStatus": "OBSERVED"}]
            })

        out = run(extract("[DevOps Lead] memory at 40 percent", call_llm=fake))
        self.assertEqual(len(out["claims"]), 1)

    def test_markdown_fences_are_tolerated(self):
        # The prompt says no markdown; a reasoning model narrates anyway, and
        # dropping a window over a stray fence is a poor trade.
        async def fenced(system, user):
            return "```json\n{\"claims\": []}\n```"

        out = run(extract("x", call_llm=fenced))
        self.assertEqual(out["claims"], [])

    def test_one_repair_retry_then_give_up_cleanly(self):
        calls = {"n": 0}

        async def flaky(system, user):
            calls["n"] += 1
            return "not json at all" if calls["n"] == 1 else json.dumps({"claims": []})

        out = run(extract("x", call_llm=flaky))
        self.assertEqual(calls["n"], 2, "the repair retry did not fire")
        self.assertEqual(out["claims"], [])

    def test_two_failures_raise_so_the_caller_can_requeue(self):
        """
        This used to return `{k: [] for k in _KEYS}` and swallow the failure
        here — but the one real caller, `LlmExtractionStep.execute()`, only
        requeues a window's drained frames inside an `except Exception`
        block, documented as firing "on any extraction exception". Returning
        normally skipped that path entirely: the frames were neither
        processed nor put back, so a window that failed schema validation
        twice in a row lost that speech silently. It must raise instead, so
        the caller's own requeue logic — which already exists and is tested
        — actually runs.
        """
        async def broken(system, user):
            return "still not json"

        with self.assertRaises(ExtractionDropped):
            run(extract("x", call_llm=broken))

    def test_pii_is_redacted_BEFORE_the_llm_sees_it(self):
        seen: dict[str, str] = {}

        async def capture(system, user):
            seen["user"] = user
            return json.dumps({"claims": []})

        run(extract("[Support Engineer] jane@acme.com cannot check out", call_llm=capture))
        self.assertNotIn("jane@acme.com", seen["user"])
        self.assertIn("[EMAIL_1]", seen["user"])


class TestCompaction(unittest.TestCase):
    """§4.4 — compaction may drop colour, never an obligation."""

    def setUp(self):
        self.led = Ledger()
        for i in range(60):
            self.led.upsert_claim(Claim(
                id=f"f{i}", text=f"fact {i}", epistemic_status="OBSERVED",
                speaker_role="DevOps Lead", confidence=0.9,
            ))
        self.led.upsert_task(Task(
            id="t1", assignee_role="Database Admin",
            description="check replica lag", status="OPEN",
        ))
        self.led.upsert_unchecked(Unchecked(id="u1", description="network path unverified"))

    def test_facts_are_trimmed(self):
        c = compact(self.led)
        self.assertLessEqual(len(c["recentFacts"]), 40)

    def test_open_tasks_are_pinned_in_full(self):
        # Requirement 10 depends on nothing being dropped.
        c = compact(self.led)
        self.assertEqual(len(c["openTasks"]), 1)

    def test_unchecked_gaps_are_pinned(self):
        c = compact(self.led)
        self.assertEqual(len(c["unchecked"]), 1)

    def test_transcripts_are_never_sent(self):
        self.assertNotIn("transcripts", compact(self.led))


# Two speakers in one window: attribution cannot be deduced, so a claim the
# model failed to attribute must be dropped rather than guessed at.
TWO_SPEAKERS = """[DevOps Lead] The cache is fine.
[Support Engineer] Logs show timeouts."""


class PlaceholderAttribution(unittest.TestCase):
    """
    §6.2 Rule 1 against a model that writes "unknown" rather than leaving the
    field blank.

    Seen live: the demo's headline guess — "Redis might be evicting keys" —
    reached the dashboard as an open question attributed to nobody. The
    emptiness check passed it because "unknown" is a non-empty string, which
    is precisely the laundering the check exists to stop.
    """

    CLAIM = {
        "text": "Redis might be evicting keys",
        "epistemicStatus": "HYPOTHESIS",
        "speakerRole": "unknown",
        "confidence": 0.5,
    }

    def _claim(self, role: str) -> dict[str, object]:
        return {**self.CLAIM, "speakerRole": role}

    def test_every_placeholder_is_treated_as_unsourced(self) -> None:
        two = TWO_SPEAKERS
        for role in (
            "unknown", "Unknown", "UNSPECIFIED", "unattributed", "n/a", "N/A",
            "none", "null", "speaker", "someone", "anonymous", "?", "-", "  ",
        ):
            with self.subTest(role=role):
                out = validate_extraction(
                    {"claims": [self._claim(role)]}, window_text=two
                )
                self.assertEqual(out["claims"], [], f"{role!r} was let through")

    def test_a_sole_speaker_is_a_deduction_not_an_invention(self) -> None:
        """
        One person spoke in the window, so a claim drawn from it can only be
        theirs. This is what keeps the hedge on the board as a properly
        sourced open question instead of silently vanishing.
        """
        one = "[DevOps Lead] Datadog looks like Redis might be evicting keys."
        out = validate_extraction({"claims": [self._claim("unknown")]}, window_text=one)
        self.assertEqual(len(out["claims"]), 1)
        self.assertEqual(out["claims"][0]["speakerRole"], "DevOps Lead")

    def test_two_speakers_means_drop_rather_than_guess(self) -> None:
        two = TWO_SPEAKERS
        out = validate_extraction({"claims": [self._claim("unknown")]}, window_text=two)
        self.assertEqual(out["claims"], [])

    def test_no_window_means_drop(self) -> None:
        out = validate_extraction({"claims": [self._claim("unknown")]})
        self.assertEqual(out["claims"], [])

    def test_a_real_role_is_untouched(self) -> None:
        two = TWO_SPEAKERS
        out = validate_extraction(
            {"claims": [self._claim("Support Engineer")]}, window_text=two
        )
        self.assertEqual(len(out["claims"]), 1)
        self.assertEqual(out["claims"][0]["speakerRole"], "Support Engineer")

    def test_a_role_merely_containing_a_placeholder_word_survives(self) -> None:
        """
        The match is anchored. "Unknown Systems Lead" is an odd job title, not
        a missing attribution, and over-matching here would silently delete
        real claims — a worse failure than the one being fixed.
        """
        one = "[Unknown Systems Lead] The cache is fine."
        out = validate_extraction(
            {"claims": [self._claim("Unknown Systems Lead")]}, window_text=one
        )
        self.assertEqual(len(out["claims"]), 1)


class GraphLinks(unittest.TestCase):
    """
    The canvas draws entities; the model was emitting claim-to-claim links.

    Read off a live snapshot: four entity nodes and five links whose endpoints
    were claim ids. React Flow drops an edge matching no node, silently, so the
    graph rendered as unconnected boxes and looked unbuilt.
    """

    ENTITIES = [{"id": "e1", "label": "checkout"}, {"id": "e2", "label": "Redis"}]
    CLAIMS = [
        {"id": "c1", "entity": "e1"},
        {"id": "c2", "entity": "e2"},
        {"id": "c3", "entity": "e1"},
    ]

    def _links(self, *links: dict) -> list[dict]:
        return resolve_links(list(links), self.ENTITIES, self.CLAIMS)

    def test_an_entity_to_entity_link_is_kept(self) -> None:
        out = self._links({"id": "l", "source": "e1", "target": "e2",
                           "label": "reads from", "kind": "depends"})
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["source"], out[0]["target"]), ("e1", "e2"))

    def test_claim_endpoints_resolve_to_their_entities(self) -> None:
        """
        A contradiction genuinely IS between two claims, so these are not
        nonsense - they are the wrong id space. Resolving each claim to its
        entity turns "these statements conflict" into "these systems are in
        tension", which a graph of systems can honestly show.
        """
        out = self._links({"id": "l", "source": "c1", "target": "c2",
                           "label": "contradiction", "kind": "suspected"})
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["source"], out[0]["target"]), ("e1", "e2"))

    def test_a_self_loop_is_dropped(self) -> None:
        # Two claims about the same system. Real, but a loop tells a reader
        # nothing they can act on.
        self.assertEqual(self._links({"id": "l", "source": "c1", "target": "c3",
                                      "label": "x", "kind": "depends"}), [])

    def test_an_unresolvable_endpoint_is_dropped(self) -> None:
        self.assertEqual(self._links({"id": "l", "source": "nope", "target": "e2",
                                      "label": "x", "kind": "depends"}), [])

    def test_a_causal_KIND_never_reaches_the_graph(self) -> None:
        """§6.2 Rule 2 does not care whether the assertion is a sentence or an
        edge. An arrow labelled "causes" is a root cause drawn on screen."""
        out = self._links({"id": "l", "source": "e1", "target": "e2",
                           "label": "", "kind": "causal"})
        self.assertEqual(out[0]["kind"], "suspected")

    def test_a_causal_LABEL_is_stripped_even_on_a_legal_kind(self) -> None:
        # The label is what a reader sees, so a compliant `kind` with a
        # diagnosing label is the same violation wearing a disguise.
        out = self._links({"id": "l", "source": "e1", "target": "e2",
                           "label": "Redis causes the 500s", "kind": "depends"})
        self.assertEqual(out[0]["kind"], "suspected")
        self.assertEqual(out[0]["label"], "")

    def test_duplicate_edges_are_collapsed(self) -> None:
        out = self._links(
            {"id": "a", "source": "e1", "target": "e2", "label": "a", "kind": "depends"},
            {"id": "b", "source": "e1", "target": "e2", "label": "b", "kind": "depends"},
        )
        self.assertEqual(len(out), 1)


if __name__ == "__main__":
    unittest.main()


class LlmSuppliedListShapes(unittest.TestCase):
    """
    A model-fed `list[str]` field can arrive as a bare string, and the type
    hint does not stop it.

    Live: asked to extract a task from "Priya, can you check the replica lag?",
    the analysis model returned

        "evidence": "Priya, can you check the replica lag in the next ten minutes?"

    The dashboard's `selectClaimsByIds` guarded with `if (!ids?.length)` — and
    a string has `.length` — so `.map` threw `ids.map is not a function`,
    React unmounted the tree, and the console reset mid-incident, losing the
    in-memory Ledger before it had been flushed to Postgres.

    One sentence, whole session. These pin the coercion that stops it.
    """

    def test_a_prose_evidence_string_is_dropped_not_wrapped(self):
        from app.models import Task

        t = Task(
            id="t1", assignee_role="Priya", description="check replica lag",
            status="OPEN",
            evidence="Priya, can you check the replica lag in the next ten minutes?",
        )
        # Dropped: `evidence` means claim ids, and a quoted sentence is not
        # one. A fake reference in the evidence chain is worse than none.
        self.assertEqual(t.evidence, [])
        self.assertIsInstance(t.evidence, list)

    def test_a_real_id_list_survives_untouched(self):
        from app.models import Task

        t = Task(id="t1", assignee_role="DBA", description="x", status="OPEN",
                 evidence=["c1", "c2"])
        self.assertEqual(t.evidence, ["c1", "c2"])

    def test_junk_entries_are_filtered(self):
        from app.models import Task

        t = Task(id="t1", assignee_role="DBA", description="x", status="OPEN",
                 evidence=["c1", None, "", {"a": 1}, "  c2  "])
        self.assertEqual(t.evidence, ["c1", "c2"])

    def test_claim_contradicts_is_coerced_the_same_way(self):
        from app.models import Claim

        c = Claim(id="c1", text="x", epistemic_status="OBSERVED",
                  speaker_role="DevOps Lead", confidence=0.9,
                  contradicts="some prose the model invented")
        self.assertEqual(c.contradicts, [])

    def test_a_lone_alias_is_KEPT_because_prose_is_not_an_id(self):
        """
        The opposite decision from `evidence`, deliberately. "Redis" as a
        single alias is genuinely one alias, and dropping it would silently
        break the entity resolution that the alias table drives.
        """
        from app.models import Entity

        e = Entity(id="redis", label="Redis", kind="datastore",
                   status="OK", aliases="the cache")
        self.assertEqual(e.aliases, ["the cache"])

    def test_none_is_an_empty_list_not_a_crash(self):
        from app.models import Task

        t = Task(id="t1", assignee_role="DBA", description="x", status="OPEN",
                 evidence=None)
        self.assertEqual(t.evidence, [])
