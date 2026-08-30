"""
Degradation ladder — v6 §13, W10.

The governing principle is that no single dependency can take down the demo,
and that a degraded system SAYS SO. A system quietly running incomplete is
worse than one that has obviously failed.
"""

from __future__ import annotations

import unittest

from app.degradation import Degradation


class TestVisibility(unittest.TestCase):

    def test_a_healthy_system_shows_no_banner(self):
        self.assertIsNone(Degradation().banner())
        self.assertFalse(Degradation().any)

    def test_losing_voice_leaves_a_working_dashboard_and_says_so(self):
        d = Degradation()
        d.voice_failed("bridge /speak failed")
        # Names the CONSEQUENCE, not the component.
        self.assertIn("ANALYTICS ONLY", d.banner())
        self.assertIn("conflicts appear here", d.banner())
        self.assertFalse(d.extraction, "losing voice must not disable analytics")

    def test_losing_extraction_leaves_voice_working(self):
        d = Degradation()
        d.extraction = True
        self.assertIn("EXTRACTION PAUSED", d.banner())
        self.assertFalse(d.voice)

    def test_a_fallback_model_is_disclosed(self):
        # Running on a smaller model is a real quality change, and the operator
        # is entitled to know the adjudicator got worse.
        d = Degradation()
        d.using_fallback_model("openai/gpt-oss-20b")
        self.assertIn("FALLBACK MODEL", d.banner())
        self.assertIn("gpt-oss-20b", d.banner())

    def test_both_down_is_reported_as_both(self):
        d = Degradation()
        d.voice_failed("x")
        d.extraction = True
        self.assertIn("VOICE", d.banner())
        self.assertIn("ANALYTICS", d.banner())


class TestEdgeTriggering(unittest.TestCase):
    """
    Transitions return True only on a CHANGE, so the hub publishes on edges.

    Without this a failing Bridge would republish the same banner on every
    utterance, and a delta that changes nothing still costs a render on every
    connected dashboard.
    """

    def test_repeated_failures_report_a_change_only_once(self):
        d = Degradation()
        self.assertTrue(d.voice_failed("first"))
        self.assertFalse(d.voice_failed("second"))
        self.assertFalse(d.voice_failed("third"))

    def test_recovery_is_an_edge_too(self):
        d = Degradation()
        d.voice_failed("x")
        self.assertTrue(d.voice_restored())
        self.assertFalse(d.voice_restored())

    def test_recovering_when_healthy_is_not_a_change(self):
        self.assertFalse(Degradation().voice_restored())

    def test_switching_between_fallbacks_is_a_change(self):
        d = Degradation()
        self.assertTrue(d.using_fallback_model("openai/gpt-oss-20b"))
        self.assertFalse(d.using_fallback_model("openai/gpt-oss-20b"))
        self.assertTrue(d.using_fallback_model("qwen/qwen3.8-27b"))

    def test_why_it_failed_is_retained_for_the_post_mortem(self):
        d = Degradation()
        d.voice_failed("bridge /speak returned 502")
        self.assertIn("502", " ".join(d.notes))


class TestWireShape(unittest.TestCase):

    def test_the_wire_carries_the_banner_the_ui_renders(self):
        d = Degradation()
        d.voice_failed("x")
        wire = d.to_wire()
        self.assertTrue(wire["voice"])
        self.assertFalse(wire["extraction"])
        self.assertIsNotNone(wire["banner"])

    def test_a_healthy_wire_has_a_null_banner(self):
        self.assertIsNone(Degradation().to_wire()["banner"])


if __name__ == "__main__":
    unittest.main()
