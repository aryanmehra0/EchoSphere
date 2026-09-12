"""
Tests for Hypothesis Elimination Matrix (Automated Telemetry-Assisted Theory Adjudication).

Guarantees:
- Hypotheses are accurately matched to telemetry probes and human observations.
- Normal telemetry readings refute resource exhaustion/crash hypotheses.
- Saturated/critical readings corroborate reported symptoms.
- Untested hypotheses remain OPEN with a suggested probe from the catalog.
- Strictly complies with Rule 1: zero causal assertions or root cause diagnoses.
"""

from __future__ import annotations

import unittest
from fastapi.testclient import TestClient

from app.domain.ledger import Ledger
from app.domain.models import Claim, now_ms
from app.domain.services.elimination import (
    HypothesisEvaluation,
    hypothesis_matrix_service,
)
from app.domain.services.telemetry import (
    _CAUSAL_FORBIDDEN,
    telemetry_service,
)
from app.main import app


class TestHypothesisEliminationMatrix(unittest.IsolatedAsyncioTestCase):
    """
    `telemetry_service.probe()` is async (it tries a live Prometheus query
    before falling back to the static catalog — see
    `app/infrastructure/prometheus_client.py`), hence `IsolatedAsyncioTestCase`
    rather than plain `TestCase`. Nothing here calls `prometheus_client.
    connect()`, so every probe below takes the static fallback path.
    """

    def setUp(self) -> None:
        self.client = TestClient(app)

    async def test_evaluate_refuted_by_ok_telemetry(self) -> None:
        """Hypothesis that Redis is out of memory is refuted by Datadog's 34.2% reading."""
        hyp = Claim(
            id="hyp-redis-mem",
            text="Maybe Redis is out of memory and evicting session keys",
            epistemic_status="HYPOTHESIS",
            speaker_role="DevOps Lead",
            confidence=0.75,
            entity="redis",
            at=now_ms() - 5000,
        )

        reading = await telemetry_service.probe("redis", "memory_utilization_pct")
        probe_claim = telemetry_service.synthesize_claim(reading)

        evals = hypothesis_matrix_service.evaluate_claims([hyp, probe_claim])
        self.assertEqual(len(evals), 1)

        ev = evals[0]
        self.assertEqual(ev.hypothesis_id, "hyp-redis-mem")
        self.assertEqual(ev.status, "REFUTED")
        self.assertEqual(ev.evidence_claim_id, probe_claim.id)
        self.assertEqual(ev.evidence_provider, "Datadog APM")
        self.assertIn("telemetry confirms normal operational thresholds", ev.reason)

    async def test_evaluate_corroborated_by_critical_telemetry(self) -> None:
        """Hypothesis of network packet drop is corroborated by CloudWatch 92.4% drop reading."""
        hyp = Claim(
            id="hyp-net-drop",
            text="Is the VPC transit gateway dropping packets between AZs?",
            epistemic_status="HYPOTHESIS",
            speaker_role="Site Reliability Engineer",
            confidence=0.80,
            entity="network",
            at=now_ms() - 4000,
        )

        reading = await telemetry_service.probe("network", "packet_drop_pct")
        probe_claim = telemetry_service.synthesize_claim(reading)

        evals = hypothesis_matrix_service.evaluate_claims([hyp, probe_claim])
        self.assertEqual(len(evals), 1)

        ev = evals[0]
        self.assertEqual(ev.hypothesis_id, "hyp-net-drop")
        self.assertEqual(ev.status, "CORROBORATED")
        self.assertEqual(ev.evidence_claim_id, probe_claim.id)
        self.assertEqual(ev.evidence_provider, "CloudWatch")
        self.assertIn("observed telemetry aligns with reported symptom", ev.reason)

    def test_evaluate_open_untested_hypothesis_with_suggested_probe(self) -> None:
        """An untested hypothesis remains OPEN and carries a suggested probe."""
        hyp = Claim(
            id="hyp-pg-pool",
            text="Postgres primary connection pool might be exhausted",
            epistemic_status="HYPOTHESIS",
            speaker_role="Database Admin",
            confidence=0.70,
            entity="postgres",
            at=now_ms() - 2000,
        )

        evals = hypothesis_matrix_service.evaluate_claims([hyp])
        self.assertEqual(len(evs := evals), 1)
        ev = evs[0]

        self.assertEqual(ev.status, "OPEN")
        self.assertIsNotNone(ev.suggested_probe)
        self.assertEqual(ev.suggested_probe["entity"], "postgres")
        self.assertEqual(ev.suggested_probe["provider"], "Prometheus")

    def test_ok_substring_inside_ordinary_words_does_not_refute(self) -> None:
        """
        Regression for a real bug: `is_ok` used to be a bare `"ok" in
        text_lower` check, which matches inside "broken", "looks", "invoke",
        etc. A free-text OBSERVED claim plainly stating something is BROKEN
        must never be classified as confirming normal operation.
        """
        hyp = Claim(
            id="hyp-pool-broken",
            text="Maybe the checkout service is dropping requests",
            epistemic_status="HYPOTHESIS",
            speaker_role="Backend Engineer",
            confidence=0.7,
            entity="checkout",
            at=now_ms() - 2000,
        )
        observation = Claim(
            id="obs-pool-broken",
            text="DevOps confirmed the connection pool looks broken under load",
            epistemic_status="OBSERVED",
            speaker_role="DevOps Lead",
            confidence=0.9,
            entity="checkout",
            at=now_ms() - 1000,
        )

        evals = hypothesis_matrix_service.evaluate_claims([hyp, observation])
        self.assertEqual(len(evals), 1)
        ev = evals[0]
        self.assertNotEqual(
            ev.status, "REFUTED",
            f"'looks broken' was misread as confirming normal operation: {ev.reason}",
        )

    async def test_rule_1_anti_causal_discipline(self) -> None:
        """Ensure no evaluation reason contains forbidden causal words."""
        hyp = Claim(
            id="hyp-checkout-err",
            text="Could the checkout service 5xx spike be caused by database timeouts?",
            epistemic_status="HYPOTHESIS",
            speaker_role="Backend Engineer",
            confidence=0.85,
            entity="checkout",
            at=now_ms() - 1000,
        )
        reading = await telemetry_service.probe("checkout", "error_rate_5xx_pct")
        probe_claim = telemetry_service.synthesize_claim(reading)

        evals = hypothesis_matrix_service.evaluate_claims([hyp, probe_claim])
        for ev in evals:
            self.assertFalse(
                _CAUSAL_FORBIDDEN.search(ev.reason),
                f"Evaluation reason violates Rule 1 causal language restriction: {ev.reason}",
            )

    async def test_reconcile_lifecycle_transitions_claim_to_refuted(self) -> None:
        """Reconciliation in ledger transitions claim.lifecycle to REFUTED."""
        ledger = Ledger(channel="test-reconcile")
        hyp = Claim(
            id="hyp-redis-1",
            text="Redis is probably evicting keys right now",
            epistemic_status="HYPOTHESIS",
            speaker_role="DevOps Lead",
            confidence=0.6,
            entity="redis",
            at=now_ms() - 3000,
        )
        ledger.upsert_claim(hyp)

        # Before probe: lifecycle is ACTIVE
        self.assertEqual(ledger.claims["hyp-redis-1"].lifecycle, "ACTIVE")

        # Telemetry probe proves Redis is healthy (34.2% memory, 0 evictions)
        reading = await telemetry_service.probe("redis")
        probe_claim = telemetry_service.synthesize_claim(reading)
        ledger.upsert_claim(probe_claim)

        # Run reconciliation
        reconciled = hypothesis_matrix_service.reconcile_lifecycle(ledger)
        self.assertEqual(len(reconciled), 1)
        self.assertEqual(reconciled[0].id, "hyp-redis-1")
        self.assertEqual(reconciled[0].lifecycle, "REFUTED")
        self.assertEqual(ledger.claims["hyp-redis-1"].lifecycle, "REFUTED")

    async def test_ledger_query_theories_scope(self) -> None:
        """Ledger.query with scope='theories' returns structured counts and arrays."""
        ledger = Ledger(channel="test-theories-query")
        hyp1 = Claim(
            id="h1",
            text="Redis cache is evicting keys",
            epistemic_status="HYPOTHESIS",
            speaker_role="DevOps Lead",
            confidence=0.7,
            entity="redis",
        )
        hyp2 = Claim(
            id="h2",
            text="Database connection pool is maxed out",
            epistemic_status="HYPOTHESIS",
            speaker_role="Database Admin",
            confidence=0.6,
            entity="postgres",
        )
        ledger.upsert_claim(hyp1)
        ledger.upsert_claim(hyp2)

        # Probe Redis to refute h1
        reading = await telemetry_service.probe("redis")
        probe_claim = telemetry_service.synthesize_claim(reading)
        ledger.upsert_claim(probe_claim)

        result = ledger.query("theories")
        self.assertIn("theories", result)
        self.assertIn("refuted", result)
        self.assertIn("open", result)
        self.assertEqual(result["counts"]["total"], 2)
        self.assertEqual(result["counts"]["refuted"], 1)
        self.assertEqual(result["counts"]["open"], 1)

    def test_api_matrix_endpoint(self) -> None:
        """GET /telemetry/matrix returns HTTP 200 with structured theories array."""
        res = self.client.get("/telemetry/matrix")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("theories", data)
        self.assertIn("counts", data)
        self.assertIn("refuted", data)
        self.assertIn("corroborated", data)
        self.assertIn("open", data)


if __name__ == "__main__":
    unittest.main()

