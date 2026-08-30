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

    def test_two_failures_drop_the_window_without_raising(self):
        # Losing one turn is acceptable; taking the pipeline down is not.
        async def broken(system, user):
            return "still not json"

        out = run(extract("x", call_llm=broken))
        self.assertEqual(out["claims"], [])
        self.assertEqual(out["entities"], [])

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


if __name__ == "__main__":
    unittest.main()
