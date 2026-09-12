"""
Unit tests for the Active Telemetry Probing Engine.

Verifies:
- Metric catalog lookup and deterministic readings
- Epistemic discipline (Rule 1): non-causal assertions only
- Correct Claim synthesis (epistemic_status = "TOOL_RESULT", confidence = 1.0)
- Telemetry REST and Fast Loop tool endpoints
"""

from __future__ import annotations

import unittest
from fastapi.testclient import TestClient

from app.domain.models import Claim
from app.domain.services.telemetry import (
    TelemetryReading,
    TelemetryService,
    telemetry_service,
)
from app.main import app


class TestTelemetryService(unittest.IsolatedAsyncioTestCase):
    """
    Domain service tests for telemetry probes.

    `probe()` is async because it now tries a real Prometheus query before
    falling back to this static catalog (see `app/infrastructure/
    prometheus_client.py`). Nothing in this test suite calls
    `prometheus_client.connect()`, so `is_enabled()` stays False and every
    probe below takes the fallback path — these assertions describe that
    fallback catalog, not a live Prometheus.
    """

    def setUp(self) -> None:
        self.service = TelemetryService()

    async def test_probe_redis_primary(self) -> None:
        reading = await self.service.probe("redis")
        self.assertEqual(reading.entity_id, "redis")
        self.assertEqual(reading.provider, "Datadog APM")
        self.assertEqual(reading.status, "OK")
        self.assertIn("memory utilization", reading.formatted.lower())
        self.assertEqual(reading.value, 34.2)
        self.assertEqual(reading.unit, "%")

    async def test_probe_postgres_replica_critical(self) -> None:
        reading = await self.service.probe("postgres-replica")
        self.assertEqual(reading.entity_id, "postgres-replica")
        self.assertEqual(reading.status, "CRITICAL")
        self.assertGreater(reading.value, 100.0)  # > 400 seconds lag

    async def test_probe_network_packet_loss(self) -> None:
        reading = await self.service.probe("network")
        self.assertEqual(reading.entity_id, "network")
        self.assertEqual(reading.provider, "CloudWatch")
        self.assertEqual(reading.status, "CRITICAL")
        self.assertEqual(reading.value, 92.4)

    async def test_probe_unknown_entity_fallback(self) -> None:
        reading = await self.service.probe("custom-search-service")
        self.assertEqual(reading.entity_id, "custom-search-service")
        self.assertEqual(reading.status, "OK")
        self.assertIn("health probe", reading.formatted.lower())

    async def test_synthesize_claim_epistemic_status(self) -> None:
        reading = await self.service.probe("redis")
        claim = self.service.synthesize_claim(reading, entity_id="redis-node-1")
        self.assertEqual(claim.epistemic_status, "TOOL_RESULT")
        self.assertEqual(claim.speaker_role, "Datadog APM")
        self.assertEqual(claim.confidence, 1.0)
        self.assertEqual(claim.entity, "redis-node-1")
        self.assertIn("Datadog APM telemetry:", claim.text)

    async def test_synthesize_claim_strictly_non_causal(self) -> None:
        # Every synthesized claim must obey Rule 1 (zero causal vocabulary)
        for entity in ["redis", "postgres", "postgres-replica", "checkout", "auth", "network", "stripe", "ingress"]:
            reading = await self.service.probe(entity)
            claim = self.service.synthesize_claim(reading)
            for forbidden in ["caused", "root cause", "culprit", "due to", "because of"]:
                self.assertNotIn(forbidden, claim.text.lower())

    def test_causal_tripwire_raises_on_bad_reading(self) -> None:
        bad_reading = TelemetryReading(
            entity_id="bad-sys",
            entity_label="Bad",
            metric_name="err",
            value=1.0,
            unit="err",
            status="CRITICAL",
            provider="Datadog APM",
            timestamp=12345,
            formatted="This caused the entire outage because of memory failure.",
        )
        with self.assertRaises(ValueError):
            self.service.synthesize_claim(bad_reading)


class TestTelemetryEndpoints(unittest.TestCase):
    """HTTP endpoint tests for telemetry probes."""

    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_get_telemetry_catalog(self) -> None:
        resp = self.client.get("/telemetry/catalog")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("redis", data)
        self.assertIn("postgres", data)
        self.assertIn("network", data)

    def test_post_telemetry_probe(self) -> None:
        resp = self.client.post("/telemetry/probe", json={"entity": "redis", "metric": "memory_utilization_pct"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "OK")
        self.assertEqual(data["reading"]["entityId"], "redis")
        self.assertEqual(data["claim"]["epistemicStatus"], "TOOL_RESULT")
        self.assertEqual(data["claim"]["speakerRole"], "Datadog APM")
        self.assertEqual(data["claim"]["confidence"], 1.0)

    def test_post_tools_probe_telemetry(self) -> None:
        resp = self.client.post("/tools/probe_telemetry", json={"entity": "postgres-replica"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "OK")
        self.assertEqual(data["entity"], "postgres-replica")
        self.assertIn("claimId", data)


if __name__ == "__main__":
    unittest.main()

