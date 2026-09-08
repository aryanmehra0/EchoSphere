"""
Deliberation Panel — §7a.

The panel's whole justification is that one prompt cannot hold both ends of a
precision/recall tradeoff. These tests pin both ends, plus the Rule 1 guard
that a live run walked straight through.
"""

from __future__ import annotations

import asyncio
import json
import os
import unittest
from dataclasses import dataclass
from unittest import mock

from app.panel import (
    DISSENT_PENALTY,
    PanelVerdict,
    Position,
    _causally_clean,
    deliberate,
    personas,
)


@dataclass
class C:
    text: str
    speaker_role: str
    entity: str = "redis"


def scripted(by_persona: dict[str, dict]):
    """
    A fake LLM that answers differently depending on which persona is asking.

    Keyed off a distinctive phrase in each system prompt, because that is the
    only thing distinguishing the calls — the user message is identical by
    design, which is what makes the personas independent.
    """
    async def call(system: str, user: str, **kwargs):  # noqa: ANN003
        if "SKEPTIC" in system:
            key = "SKEPTIC"
        elif "SEEKER" in system:
            key = "SEEKER"
        else:
            key = "REFEREE"
        if key not in by_persona:
            raise RuntimeError(f"no scripted answer for {key}")
        return json.dumps(by_persona[key])

    return call


class CausalTripwire(unittest.TestCase):
    """Rule 1, enforced in code rather than requested in a prompt."""

    def test_drops_the_sentence_that_actually_leaked(self):
        # Verbatim from the first live panel run. The phrase-list version of
        # the tripwire passed this straight through onto the dashboard.
        leaked = (
            "The Seeker incorrectly treated the causal link between performance "
            "degradation and user complaints as independent, ignoring that ticket "
            "volume is a downstream consequence of the latency issue."
        )
        self.assertEqual(_causally_clean(leaked, where="REFEREE"), "")

    def test_drops_the_second_leak_causally_linked(self):
        # Second live escape, from a later run. "causally" is not a form of
        # cause the first connector list matched, and "symptoms"/"incident"
        # were not treated as telemetry.
        leaked = (
            "The Seeker incorrectly treated the two statements as unrelated "
            "metrics, failing to recognize that they are causally linked "
            "symptoms of the same underlying incident."
        )
        self.assertEqual(_causally_clean(leaked, where="REFEREE"), "")

    def test_drops_plain_causal_diagnosis(self):
        for text in [
            "High latency is a direct technical cause of user-facing failures.",
            "The timeouts result from Redis evicting keys.",
            "Memory pressure led to the checkout errors.",
            "The deploy is responsible for the 500s.",
            "Cache eviction explains the spike.",
        ]:
            with self.subTest(text=text):
                self.assertEqual(_causally_clean(text, where="t"), "")

    def test_keeps_reasoning_about_a_READING(self):
        # The panel must still be able to say why an analyst was wrong. These
        # carry a causal connector but no telemetry noun, which is exactly the
        # distinction the guard is built on.
        for text in [
            "The other analyst is wrong because they ignored the health verdict.",
            "This reading is better supported by what was actually stated.",
            "One statement asserts a verdict the other's measurement denies.",
        ]:
            with self.subTest(text=text):
                self.assertEqual(_causally_clean(text, where="t"), text)

    def test_keeps_the_clean_half_of_a_mixed_answer(self):
        mixed = (
            "One speaker asserts a verdict the other denies. "
            "The timeouts were caused by memory pressure."
        )
        self.assertEqual(
            _causally_clean(mixed, where="t"),
            "One speaker asserts a verdict the other denies.",
        )


class PanelReconciliation(unittest.TestCase):

    def run_panel(self, script) -> PanelVerdict:
        return asyncio.run(
            deliberate(
                C("The cache is fine.", "DevOps Lead"),
                C("cache read timeouts on checkout", "Support Engineer"),
                call_llm=scripted(script),
            )
        )

    def test_the_rehearsal_miss_is_caught_when_either_analyst_sees_it(self):
        """
        The defect this whole module exists for.

        A single judge returned INDEPENDENT on this pair and the room heard
        nothing. The panel only needs ONE analyst to notice.
        """
        v = self.run_panel({
            "SKEPTIC": {"relation": "INDEPENDENT", "confidence": 0.55, "why": "different properties"},
            "SEEKER": {"relation": "OPPOSED", "confidence": 0.95, "why": "a cache serving timeouts is not fine"},
            "REFEREE": {"relation": "OPPOSED", "confidence": 0.9, "why": "a verdict denied by a measurement",
                        "why_other_failed": "the Skeptic read a verdict as a property"},
        })
        self.assertEqual(v.relation, "OPPOSED")
        self.assertTrue(v.dissent)
        self.assertTrue(v.is_actionable)
        self.assertEqual(v.why_other_failed, "the Skeptic read a verdict as a property")

    def test_unanimous_agreement_averages_rather_than_takes_the_max(self):
        # Two judges agreeing at 0.6 is not one judge certain at 0.95.
        v = self.run_panel({
            "SKEPTIC": {"relation": "OPPOSED", "confidence": 0.60, "why": "a"},
            "SEEKER": {"relation": "OPPOSED", "confidence": 0.90, "why": "b"},
        })
        self.assertEqual(v.relation, "OPPOSED")
        self.assertAlmostEqual(v.confidence, 0.75)
        self.assertFalse(v.dissent)

    def test_a_split_costs_confidence(self):
        v = self.run_panel({
            "SKEPTIC": {"relation": "AGREES", "confidence": 0.9, "why": "a"},
            "SEEKER": {"relation": "OPPOSED", "confidence": 0.9, "why": "b"},
            "REFEREE": {"relation": "OPPOSED", "confidence": 0.90, "why": "c"},
        })
        self.assertTrue(v.dissent)
        self.assertAlmostEqual(v.confidence, 0.90 - DISSENT_PENALTY)

    def test_a_failed_referee_falls_back_to_the_QUIETER_reading(self):
        """A broken tie-breaker must not interrupt the room."""
        async def call(system: str, user: str, **kwargs):  # noqa: ANN003
            if "REFEREE" in system:
                raise RuntimeError("model unavailable")
            if "SKEPTIC" in system:
                return json.dumps({"relation": "AGREES", "confidence": 0.9, "why": "symptoms"})
            return json.dumps({"relation": "OPPOSED", "confidence": 0.95, "why": "conflict"})

        v = asyncio.run(deliberate(
            C("Tickets are flooding in.", "Support Engineer"),
            C("Latency is through the roof.", "DevOps Lead"),
            call_llm=call,
        ))
        self.assertEqual(v.relation, "AGREES")   # the Skeptic's quieter read
        self.assertFalse(v.is_actionable)
        self.assertTrue(v.dissent)

    def test_unanimous_INDEPENDENT_must_not_interrupt_the_room(self):
        """
        The panel's own false positive, pinned.

        A live run surfaced "users say their carts empty" against "latency is
        through the roof" as unanimous INDEPENDENT@0.90 and interrupted the
        bridge. Both analysts were right — and that is precisely the point:
        easy agreement that two claims are independent is the DEFAULT for any
        two claims about one entity, so it cannot be what earns an alert.
        """
        v = self.run_panel({
            "SKEPTIC": {"relation": "INDEPENDENT", "confidence": 0.95, "why": "a"},
            "SEEKER": {"relation": "INDEPENDENT", "confidence": 0.95, "why": "b"},
        })
        self.assertEqual(v.relation, "INDEPENDENT")
        self.assertFalse(v.dissent)
        self.assertFalse(
            v.is_actionable,
            "unanimous INDEPENDENT at high confidence must stay quiet",
        )

    def test_contested_INDEPENDENT_still_earns_the_alert(self):
        """A split IS the signal — that is what replaces raw confidence."""
        v = self.run_panel({
            "SKEPTIC": {"relation": "AGREES", "confidence": 0.7, "why": "a"},
            "SEEKER": {"relation": "INDEPENDENT", "confidence": 0.99, "why": "b"},
            "REFEREE": {"relation": "INDEPENDENT", "confidence": 0.99,
                        "why": "they are reasoning from different properties"},
        })
        self.assertEqual(v.relation, "INDEPENDENT")
        self.assertTrue(v.dissent)
        self.assertTrue(v.is_actionable)

    def test_total_panel_failure_is_silence_not_a_guess(self):
        async def dead(system: str, user: str, **kwargs):  # noqa: ANN003
            raise RuntimeError("groq down")

        v = asyncio.run(deliberate(
            C("a", "DevOps Lead"), C("b", "Support Engineer"), call_llm=dead,
        ))
        self.assertFalse(v.is_actionable)
        self.assertEqual(v.confidence, 0.0)

    def test_a_lone_survivor_does_not_gain_confidence_from_being_alone(self):
        async def half_dead(system: str, user: str, **kwargs):  # noqa: ANN003
            if "SEEKER" in system:
                raise RuntimeError("quota exhausted")
            return json.dumps({"relation": "OPPOSED", "confidence": 0.9, "why": "x"})

        v = asyncio.run(deliberate(
            C("a", "DevOps Lead"), C("b", "Support Engineer"), call_llm=half_dead,
        ))
        self.assertEqual(v.relation, "OPPOSED")
        self.assertAlmostEqual(v.confidence, 0.9 - DISSENT_PENALTY)

    def test_personas_run_on_different_models(self):
        """
        Independence and quota both depend on this. If the pinning regresses,
        the panel silently becomes one model talking to itself.

        ── WHY THE ENV IS PINNED HERE ──────────────────────────────────────
        `personas()` reads the ACTIVE provider's chain, so this test used to
        depend on whatever was in `.env.local` — and it started failing the
        moment a single-model Gemma server was configured. The assertion was
        right and the test was under-specified: it is about the PINNING
        mechanism, which must keep working regardless of which provider is
        selected on this machine.

        A genuinely single-model provider collapsing to one model is a
        separate, expected case, covered below.
        """
        seen: list[list[str]] = []

        async def record(system: str, user: str, **kwargs):  # noqa: ANN003
            seen.append(kwargs.get("models"))
            return json.dumps({"relation": "AGREES", "confidence": 0.8, "why": "x"})

        with mock.patch.dict(os.environ, {
            "GROQ_API_KEY": "gsk_test",
            "ANALYSIS_PROVIDER": "groq",
            "ANALYSIS_MODEL": "model-a",
            "ANALYSIS_MODEL_FALLBACKS": "model-b,model-c",
        }):
            asyncio.run(deliberate(
                C("a", "DevOps Lead"), C("b", "Support Engineer"), call_llm=record,
            ))

        self.assertEqual(len(seen), 2)
        self.assertTrue(all(m and len(m) == 1 for m in seen))
        self.assertNotEqual(seen[0], seen[1])

    def test_a_single_model_provider_collapses_and_says_so(self):
        """
        A local server usually hosts ONE model, so the bench cannot be spread
        across three. That is acceptable — the personas' prompts differ, which
        is where most of the independence comes from — but it is a real
        reduction in it, so `panel.personas()` warns rather than degrading
        quietly.

        This is the case the sibling test above deliberately does not cover.
        """
        with mock.patch.dict(os.environ, {
            "GROQ_API_KEY": "",
            "GEMMA_BASE_URL": "http://127.0.0.1:8444/v1",
            "ANALYSIS_PROVIDER": "gemma",
            "GEMMA_MODEL": "only-one",
            "GEMMA_MODEL_FALLBACKS": "",
        }):
            with self.assertLogs("echo.panel", level="WARNING") as caught:
                bench, referee = personas()

        self.assertEqual({p.model for p in [*bench, referee]}, {"only-one"})
        self.assertTrue(
            any("one model" in line.lower() for line in caught.output),
            f"expected a warning about lost independence, got {caught.output}",
        )


class PositionSerialisation(unittest.TestCase):
    def test_positions_reach_the_dashboard_intact(self):
        v = PanelVerdict(
            relation="OPPOSED", confidence=0.9, why="w", dissent=True,
            positions=[Position("SKEPTIC", "m1", "INDEPENDENT", 0.5, "a")],
        )
        d = v.as_dict()
        self.assertTrue(d["dissent"])
        self.assertEqual(d["positions"][0]["persona"], "SKEPTIC")


if __name__ == "__main__":
    unittest.main()
