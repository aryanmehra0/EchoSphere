"""
Room Tension Index — v6 §8, closing G5.

The three defects G5 identified in v5's formula are each asserted here:
unbounded/non-commensurate output, no real pitch handling, and no hysteresis.
"""

from __future__ import annotations

import unittest

from app.rti import (
    FALL_THRESHOLD,
    INTERVENTION_COOLDOWN_SECONDS,
    RISE_THRESHOLD,
    ParticipantFrame,
    RTIMonitor,
)


def calm(uid: int, t: float) -> ParticipantFrame:
    return ParticipantFrame(uid=uid, rms=0.10, f0=120.0, speaking=False)


def shouting(uid: int, t: float) -> ParticipantFrame:
    return ParticipantFrame(uid=uid, rms=0.90, f0=240.0, speaking=True)


def settle(m: RTIMonitor, frames_fn, seconds: float, start: float = 0.0) -> float:
    """Feed 200ms slices for `seconds`, return the final index."""
    t = start
    while t < start + seconds:
        m.observe(frames_fn(t), t)
        t += 0.2
    return m.value


class TestBoundedAndCommensurate(unittest.TestCase):
    """G5 defect 1: v5's sum was dimensionally meaningless and unbounded."""

    def test_the_index_is_always_within_zero_and_one(self):
        m = RTIMonitor()
        # Absurd inputs — a clipped mic, a bad frame, a pitch estimator gone wrong.
        for t in range(200):
            m.observe([
                ParticipantFrame(uid=1001, rms=1e9, f0=100000.0, speaking=True),
                ParticipantFrame(uid=1002, rms=-5.0, f0=-1.0, speaking=True),
            ], t * 0.2)
            self.assertGreaterEqual(m.value, 0.0)
            self.assertLessEqual(m.value, 1.0)

    def test_nan_and_inf_cannot_poison_the_index(self):
        m = RTIMonitor()
        m.observe([ParticipantFrame(uid=1001, rms=float("nan"), f0=float("inf"), speaking=True)], 0.0)
        self.assertFalse(m.value != m.value, "index became NaN")

    def test_a_quiet_room_stays_near_zero(self):
        m = RTIMonitor()
        value = settle(m, lambda t: [calm(1001, t), calm(1002, t)], 30.0)
        self.assertLess(value, FALL_THRESHOLD)
        self.assertEqual(m.state, "CALM")


class TestPerParticipantBaselines(unittest.TestCase):
    """A naturally loud engineer must not read as permanently tense."""

    def test_a_consistently_loud_speaker_does_not_register_as_tension(self):
        m = RTIMonitor()
        # Loud, but LOUD CONSTANTLY — that is their normal.
        value = settle(m, lambda t: [
            ParticipantFrame(uid=1001, rms=0.85, f0=200.0, speaking=False),
            ParticipantFrame(uid=1002, rms=0.80, f0=190.0, speaking=False),
        ], 30.0)
        self.assertLess(value, RISE_THRESHOLD)

    def test_a_baseline_needs_history_before_it_counts(self):
        m = RTIMonitor()
        m.observe([ParticipantFrame(uid=1001, rms=0.9, f0=300.0, speaking=True)], 0.0)
        # One frame cannot establish a deviation from anything.
        self.assertLess(m.value, 0.2)


class TestOverlap(unittest.TestCase):
    """Overlap carries the heaviest weight — it is the least ambiguous signal."""

    def test_sustained_overlap_drives_the_index_up(self):
        m = RTIMonitor()
        settle(m, lambda t: [calm(1001, t), calm(1002, t)], 10.0)
        before = m.value
        after = settle(m, lambda t: [shouting(1001, t), shouting(1002, t)], 40.0, start=10.0)
        self.assertGreater(after, before)

    def test_one_person_talking_is_never_overlap(self):
        m = RTIMonitor()
        value = settle(m, lambda t: [
            ParticipantFrame(uid=1001, rms=0.5, f0=150.0, speaking=True),
            ParticipantFrame(uid=1002, rms=0.1, f0=120.0, speaking=False),
        ], 40.0)
        self.assertLess(value, RISE_THRESHOLD)


class TestHysteresis(unittest.TestCase):
    """
    G5 defect 3 — the one that made v5's RTI fire continuously.

    The rise threshold sits well above the fall threshold, so a value drifting
    around the middle cannot oscillate the state.
    """

    def test_the_dead_band_holds_the_current_state(self):
        m = RTIMonitor()
        m.state = "ELEVATED"
        m.value = (RISE_THRESHOLD + FALL_THRESHOLD) / 2
        m._advance(100.0)
        self.assertEqual(m.state, "ELEVATED", "a mid-band value flipped the state")

    def test_crossing_up_briefly_is_not_enough(self):
        m = RTIMonitor()
        m.value = RISE_THRESHOLD + 0.1
        m._advance(0.0)
        m._advance(3.0)  # only 3s — the sustain requirement is 8s
        self.assertEqual(m.state, "CALM")

    def test_sustained_crossing_promotes_to_elevated(self):
        m = RTIMonitor()
        m.value = RISE_THRESHOLD + 0.1
        m._advance(0.0)
        m._advance(9.0)
        self.assertEqual(m.state, "ELEVATED")

    def test_falling_back_needs_a_longer_sustain_than_rising(self):
        # Asymmetric on purpose: it should be harder to declare calm than to
        # declare tension.
        m = RTIMonitor()
        m.state = "ELEVATED"
        m.value = FALL_THRESHOLD - 0.1
        m._advance(0.0)
        m._advance(10.0)
        self.assertEqual(m.state, "ELEVATED", "declared calm too eagerly")
        m._advance(16.0)
        self.assertEqual(m.state, "CALM")


class TestInterventionCooldown(unittest.TestCase):
    """
    §8.2's third brake. At most one intervention every 90s no matter what the
    room does — Echo commenting twice a minute on the tone would itself become
    the problem.
    """

    def test_no_intervention_while_calm(self):
        m = RTIMonitor()
        self.assertFalse(m.should_intervene(1000.0))

    def test_first_elevated_intervention_is_allowed(self):
        m = RTIMonitor()
        m.state = "ELEVATED"
        self.assertTrue(m.should_intervene(1000.0))

    def test_a_second_intervention_is_blocked_inside_the_cooldown(self):
        m = RTIMonitor()
        m.state = "ELEVATED"
        m.mark_intervened(1000.0)
        m.state = "ELEVATED"  # tension persisted
        self.assertFalse(m.should_intervene(1000.0 + INTERVENTION_COOLDOWN_SECONDS - 1))

    def test_it_is_allowed_again_once_the_cooldown_expires(self):
        m = RTIMonitor()
        m.state = "ELEVATED"
        m.mark_intervened(1000.0)
        m.state = "ELEVATED"
        self.assertTrue(m.should_intervene(1000.0 + INTERVENTION_COOLDOWN_SECONDS + 1))

    def test_v6_s4_gate_at_most_two_interventions_in_three_minutes(self):
        """
        The S4 gate verbatim: '<= 2 RTI interventions in 3 min'.

        Simulated as a room that is loudly arguing for the entire three
        minutes — the worst case the cooldown exists to bound.
        """
        m = RTIMonitor()
        interventions = 0
        t = 0.0
        while t < 180.0:
            m.observe([shouting(1001, t), shouting(1002, t)], t)
            if m.should_intervene(t):
                m.mark_intervened(t)
                interventions += 1
            t += 0.2

        self.assertLessEqual(
            interventions, 2,
            f"{interventions} interventions in 3 minutes — Echo would be nagging",
        )


if __name__ == "__main__":
    unittest.main()
