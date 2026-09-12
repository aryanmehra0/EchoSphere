import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app


class TestAudioStreamRouter(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_missing_channel_or_uid_rejected(self) -> None:
        resp = self.client.post("/observer/acoustic_telemetry", json={"energy_rms": 0.05})
        self.assertEqual(resp.status_code, 400)

    def test_agent_self_exclusion_g2(self) -> None:
        # If UID matches session agent_id, telemetry is dropped
        with patch("app.web.routers.audio_stream.session") as mock_sess:
            mock_session_obj = MagicMock()
            mock_session_obj.agent = {"agent_id": "9999"}
            mock_session_obj.hub.publish = AsyncMock()
            mock_sess.return_value = mock_session_obj

            resp = self.client.post(
                "/observer/acoustic_telemetry",
                json={"channel": "inc-4417", "uid": 9999, "energy_rms": 0.05},
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data.get("status"), "dropped")
            self.assertEqual(data.get("reason"), "agent_self_exclusion")

    def test_valid_telemetry_updates_rti(self) -> None:
        with patch("app.web.routers.audio_stream.session") as mock_sess:
            mock_session_obj = MagicMock()
            mock_session_obj.agent = {"agent_id": "9999"}
            mock_session_obj.ledger.rti = 0.2
            mock_session_obj.hub.publish = AsyncMock()
            mock_sess.return_value = mock_session_obj

            resp = self.client.post(
                "/observer/acoustic_telemetry",
                json={
                    "channel": "inc-4417",
                    "uid": 1001,
                    "energy_rms": 0.09,
                    "vad_active": True,
                },
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data.get("status"), "received")
            self.assertGreater(data.get("current_rti", 0), 0.2)

    def test_observer_config_endpoint(self) -> None:
        with patch("app.web.routers.audio_stream.session") as mock_sess:
            mock_session_obj = MagicMock()
            mock_session_obj.channel = "inc-4417"
            mock_session_obj.agent = {"agent_id": "9999"}
            mock_session_obj.ledger.rti = 0.35
            mock_sess.return_value = mock_session_obj

            resp = self.client.get("/observer/config")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data.get("active_channel"), "inc-4417")
            self.assertEqual(data.get("agent_uid"), 9999)
            self.assertEqual(data.get("current_rti"), 0.35)

    def test_batched_window_telemetry_with_overlap_elevation(self) -> None:
        with patch("app.web.routers.audio_stream.session") as mock_sess:
            mock_session_obj = MagicMock()
            mock_session_obj.agent = {"agent_id": "9999"}
            mock_session_obj.ledger.rti = 0.2
            mock_session_obj.hub.publish = AsyncMock()
            mock_sess.return_value = mock_session_obj

            resp = self.client.post(
                "/observer/acoustic_telemetry",
                json={
                    "channel": "inc-4417",
                    "window_ms": 500,
                    "active_uids": [1001, 1002],
                    "energy_rms": 0.06,
                    "peak_energy_rms": 0.08,
                    "vad_active": True,
                    "overlap_detected": True,
                },
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data.get("status"), "received")
            # Overlap causes +0.10 bump
            self.assertAlmostEqual(data.get("current_rti", 0), 0.3, places=2)
            self.assertTrue(data.get("overlap_detected"))


if __name__ == "__main__":
    unittest.main()
