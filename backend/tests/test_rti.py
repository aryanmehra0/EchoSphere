"""
Unit tests for Room Tension Index (RTI) Service and Acoustic Telemetry.
"""

from __future__ import annotations

import unittest
from fastapi.testclient import TestClient

from app.main import app
from app.application.services.session import registry
from app.domain.services.rti import RoomTensionService, rti_service


class TestRoomTensionService(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = RoomTensionService(critical_threshold=0.75, normal_threshold=0.50, decay_rate=0.02)

    def test_band_classification(self) -> None:
        self.assertEqual(self.svc.classify_band(0.10), "STABLE")
        self.assertEqual(self.svc.classify_band(0.30), "NORMAL")
        self.assertEqual(self.svc.classify_band(0.55), "WARNING")
        self.assertEqual(self.svc.classify_band(0.85), "CRITICAL")

    def test_overlap_elevates_rti(self) -> None:
        reading = self.svc.compute_next_rti(
            current_rti=0.20,
            energy_rms=0.04,
            peak_energy_rms=0.06,
            vad_active=True,
            overlap_detected=True,
            active_talker_count=2,
        )
        self.assertAlmostEqual(reading.rti, 0.30)
        self.assertTrue(reading.overlap)
        self.assertFalse(reading.escalated)

    def test_volume_elevation_increases_rti(self) -> None:
        reading = self.svc.compute_next_rti(
            current_rti=0.30,
            energy_rms=0.15,
            peak_energy_rms=0.22,
            vad_active=True,
            overlap_detected=False,
            active_talker_count=1,
        )
        self.assertAlmostEqual(reading.rti, 0.35)

    def test_silence_decays_rti(self) -> None:
        reading = self.svc.compute_next_rti(
            current_rti=0.50,
            energy_rms=0.0,
            peak_energy_rms=0.0,
            vad_active=False,
            overlap_detected=False,
            active_talker_count=0,
        )
        self.assertAlmostEqual(reading.rti, 0.48)

    def test_critical_escalation_flag(self) -> None:
        reading = self.svc.compute_next_rti(
            current_rti=0.72,
            energy_rms=0.10,
            peak_energy_rms=0.18,
            vad_active=True,
            overlap_detected=True,
            active_talker_count=2,
        )
        self.assertGreaterEqual(reading.rti, 0.75)
        self.assertEqual(reading.band, "CRITICAL")
        self.assertTrue(reading.escalated)


class TestAcousticTelemetryRouter(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.channel = "inc-telemetry-test"
        self.session = registry.reset(self.channel)

    def test_observer_config_returns_active_channel(self) -> None:
        res = self.client.get("/observer/config")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("active_channel", data)
        self.assertIn("current_rti", data)

    def test_acoustic_telemetry_updates_session_rti(self) -> None:
        self.session.ledger.rti = 0.20
        payload = {
            "channel": self.channel,
            "uid": 1001,
            "energy_rms": 0.05,
            "peak_energy_rms": 0.08,
            "vad_active": True,
            "overlap_detected": True,
        }
        res = self.client.post("/observer/acoustic_telemetry", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "received")
        self.assertAlmostEqual(data["current_rti"], 0.30)
        self.assertAlmostEqual(self.session.ledger.rti, 0.30)

