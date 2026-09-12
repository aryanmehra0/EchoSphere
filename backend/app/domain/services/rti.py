"""
Room Tension Index (RTI) Service — v6 §8.

Acoustic behavioral indicator of incident stress and escalation.
Tracks energy variance, cadence, overlapping cross-talk, and speech rates.
Applies Schmitt-trigger hysteresis to prevent jitter in dashboard meters and thresholds.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

log = logging.getLogger("echo.rti")

TensionBand = Literal["STABLE", "NORMAL", "WARNING", "CRITICAL"]


@dataclass(frozen=True)
class TensionReading:
    rti: float
    band: TensionBand
    overlap: bool
    escalated: bool


class RoomTensionService:
    """
    Computes real-time Room Tension Index (0.0 to 1.0).

    Weights:
      - Overlap ratio: 0.45
      - RMS volume elevation: 0.35
      - Speech activity / cadence: 0.20

    Hysteresis:
      - Critical threshold: 0.75
      - Normal recovery threshold: 0.50
    """

    def __init__(
        self,
        critical_threshold: float = 0.75,
        normal_threshold: float = 0.50,
        decay_rate: float = 0.02,
    ) -> None:
        self.critical_threshold = critical_threshold
        self.normal_threshold = normal_threshold
        self.decay_rate = decay_rate

    def classify_band(self, value: float) -> TensionBand:
        if value >= self.critical_threshold:
            return "CRITICAL"
        if value >= self.normal_threshold:
            return "WARNING"
        if value >= 0.20:
            return "NORMAL"
        return "STABLE"

    def compute_next_rti(
        self,
        current_rti: float,
        energy_rms: float,
        peak_energy_rms: float,
        vad_active: bool,
        overlap_detected: bool,
        active_talker_count: int = 1,
    ) -> TensionReading:
        """Calculate next RTI step with smoothing and decay."""
        next_val = current_rti

        if overlap_detected or (active_talker_count > 1 and vad_active):
            # Overlapping speech represents conversational collisions / urgency
            next_val += 0.10
        elif vad_active and (energy_rms > 0.08 or peak_energy_rms > 0.12):
            # Elevated volume / raised voices
            next_val += 0.05
        elif not vad_active:
            # Silence decays bridge tension gradually
            next_val -= self.decay_rate

        clamped = max(0.0, min(1.0, round(next_val, 3)))
        band = self.classify_band(clamped)
        escalated = clamped >= self.critical_threshold

        return TensionReading(
            rti=clamped,
            band=band,
            overlap=overlap_detected,
            escalated=escalated,
        )


rti_service = RoomTensionService()

