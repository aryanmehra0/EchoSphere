"""
Room Tension Index — v6 §8, closing G5.

────────────────────────────────────────────────────────────────────────────
THE GAP THIS CLOSES

v5's formula was  RTI = α·σ_v + β·Fo_dev + γ·D_overlap  and it does not compute:

  1. Non-commensurate units. σ_v is dBFS, Fo_dev is Hz, D_overlap is events per
     minute. Their weighted sum is dimensionally meaningless and unbounded, so
     no fixed threshold can exist.
  2. The named input does not provide pitch. `vad_result_state` is a
     speech/non-speech classification; F0 needs real extraction over the PCM.
  3. No smoothing or hysteresis. A raw per-frame index crosses any threshold
     dozens of times a minute, so "the AI interrupts with a calming summary"
     fires continuously.

v6 fixes all three: every term is normalised against each participant's OWN
rolling baseline and clipped to [0,1], the sum is EWMA-smoothed, and the state
machine is a Schmitt trigger with a hard cooldown.
────────────────────────────────────────────────────────────────────────────

The dashboard reacts before Echo does. Entering ELEVATED pulses the meter
immediately — free, silent, and often sufficient, since a team that SEES the
tension climb frequently self-corrects. Echo only speaks if it persists through
the cooldown. That is the difference between a system that helps and one that
nags.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Literal

log = logging.getLogger("echo.rti")

# §8.1 weights. Overlap carries the most because it is the most reliable and
# most interpretable signal of a room losing coherence: people talking over each
# other is DEFINITIONALLY a breakdown in turn-taking, whereas volume and pitch
# have benign explanations (a loud room, an excited but productive engineer).
W_VOLUME = 0.30
W_PITCH = 0.25
W_OVERLAP = 0.45

EWMA_LAMBDA = 0.85

# §8.2 Schmitt trigger. The rise threshold sits well above the fall threshold so
# noise cannot oscillate the state.
RISE_THRESHOLD = 0.62
FALL_THRESHOLD = 0.45
RISE_SUSTAIN_SECONDS = 8.0
FALL_SUSTAIN_SECONDS = 15.0
INTERVENTION_COOLDOWN_SECONDS = 90.0

# Overlap events per minute at which the term saturates.
OVERLAP_SATURATION = 12.0

# A baseline needs some history before it means anything; until then the
# participant contributes nothing rather than contributing noise.
MIN_BASELINE_SAMPLES = 12

State = Literal["CALM", "ELEVATED", "INTERVENED"]


@dataclass
class Baseline:
    """
    A participant's own normal, learned continuously.

    Per-participant on purpose: a naturally loud engineer must not read as
    permanently tense, and a quiet one must not be able to hide a real
    escalation. Tension is a change from YOUR baseline, not an absolute level.
    """

    n: int = 0
    mean: float = 0.0
    m2: float = 0.0  # Welford's aggregator

    def update(self, value: float) -> None:
        self.n += 1
        delta = value - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (value - self.mean)

    @property
    def stdev(self) -> float:
        if self.n < 2:
            return 0.0
        return math.sqrt(self.m2 / (self.n - 1))

    @property
    def ready(self) -> bool:
        return self.n >= MIN_BASELINE_SAMPLES


def _clip01(value: float) -> float:
    if math.isnan(value) or math.isinf(value):
        return 0.0
    return max(0.0, min(1.0, value))


@dataclass
class ParticipantFrame:
    """One 200ms observation for a single UID."""

    uid: int
    rms: float
    """Linear RMS amplitude of the validated speech bytes."""
    f0: float | None = None
    """Fundamental frequency in Hz, voiced frames only. None when unvoiced."""
    speaking: bool = False


@dataclass
class RTIMonitor:
    """
    Computes the index and owns the state machine.

    Fed from the Observer's metrics fork, which sits UPSTREAM of STT (§4.3):
    tension is a property of HOW people are speaking, not what they said, so it
    is computed from the PCM directly and never blocks on transcription.
    """

    volume: dict[int, Baseline] = field(default_factory=dict)
    pitch: dict[int, Baseline] = field(default_factory=dict)

    value: float = 0.0
    state: State = "CALM"

    _above_since: float | None = None
    _below_since: float | None = None
    _last_intervention: float | None = None
    _overlap_events: list[float] = field(default_factory=list)

    # -- the three normalised terms ----------------------------------------

    def _volume_term(self, frames: list[ParticipantFrame]) -> float:
        """
        Cross-participant volume SPREAD — people getting louder relative to
        each other, not louder in absolute terms. A noisy room raises everyone
        equally and should not register as tension.
        """
        deviations: list[float] = []
        for f in frames:
            base = self.volume.setdefault(f.uid, Baseline())
            if base.ready and base.stdev > 0:
                deviations.append((f.rms - base.mean) / (3 * base.stdev))
            base.update(f.rms)

        if not deviations:
            return 0.0
        return _clip01(sum(deviations) / len(deviations))

    def _pitch_term(self, frames: list[ParticipantFrame]) -> float:
        """
        Pitch deviation from each speaker's own baseline — stress in the voice.

        ABSOLUTE deviation: dropping into a flat, clipped register is as much a
        stress signal as going shrill, and a signed mean would let the two
        cancel out across a room.
        """
        deviations: list[float] = []
        for f in frames:
            if f.f0 is None or f.f0 <= 0:
                continue  # unvoiced frame — no pitch to speak of
            base = self.pitch.setdefault(f.uid, Baseline())
            if base.ready and base.stdev > 0:
                deviations.append(abs(f.f0 - base.mean) / (2 * base.stdev))
            base.update(f.f0)

        if not deviations:
            return 0.0
        return _clip01(sum(deviations) / len(deviations))

    def _overlap_term(self, frames: list[ParticipantFrame], now: float) -> float:
        """Overlapping-speech events per minute, normalised against saturation."""
        if sum(1 for f in frames if f.speaking) >= 2:
            self._overlap_events.append(now)

        cutoff = now - 60.0
        self._overlap_events = [t for t in self._overlap_events if t >= cutoff]

        return _clip01(len(self._overlap_events) / OVERLAP_SATURATION)

    # -- the index ---------------------------------------------------------

    def observe(self, frames: list[ParticipantFrame], now: float) -> float:
        """Fold one 200ms slice in and return the smoothed index."""
        raw = (
            W_VOLUME * self._volume_term(frames)
            + W_PITCH * self._pitch_term(frames)
            + W_OVERLAP * self._overlap_term(frames, now)
        )

        # EWMA. Without it a raw per-frame index crosses any threshold dozens of
        # times a minute (G5's third defect).
        self.value = EWMA_LAMBDA * self.value + (1 - EWMA_LAMBDA) * raw
        self._advance(now)
        return self.value

    # -- the state machine -------------------------------------------------

    def _advance(self, now: float) -> None:
        if self.value > RISE_THRESHOLD:
            self._below_since = None
            if self._above_since is None:
                self._above_since = now
        elif self.value < FALL_THRESHOLD:
            self._above_since = None
            if self._below_since is None:
                self._below_since = now
        else:
            # Between the thresholds: the trigger holds its current state. This
            # dead band IS the hysteresis.
            self._above_since = None
            self._below_since = None
            return

        sustained_up = (
            self._above_since is not None
            and now - self._above_since >= RISE_SUSTAIN_SECONDS
        )
        sustained_down = (
            self._below_since is not None
            and now - self._below_since >= FALL_SUSTAIN_SECONDS
        )

        if self.state == "CALM" and sustained_up:
            self.state = "ELEVATED"
            log.info("rti: CALM -> ELEVATED (%.2f)", self.value)
        elif self.state in ("ELEVATED", "INTERVENED") and sustained_down:
            self.state = "CALM"
            log.info("rti: -> CALM (%.2f)", self.value)

    def should_intervene(self, now: float) -> bool:
        """
        True only when tension is ELEVATED and the cooldown has expired.

        Bounds interventions to at most one every 90 seconds no matter what the
        room does. Echo speaking twice in a minute about the tone of the
        conversation would itself become the problem.
        """
        if self.state != "ELEVATED":
            return False
        if self._last_intervention is None:
            return True
        return (now - self._last_intervention) >= INTERVENTION_COOLDOWN_SECONDS

    def mark_intervened(self, now: float) -> None:
        self._last_intervention = now
        self.state = "INTERVENED"
        log.info("rti: intervention delivered, cooldown restarted")

    def reset(self) -> None:
        self.__init__()  # type: ignore[misc]
