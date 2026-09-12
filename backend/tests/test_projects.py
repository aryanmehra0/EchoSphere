"""
Unit tests for the Enterprise Project Workspaces feature.

Verifies:
- The seeded demo workspace is discoverable via the domain service
- Connector save/test updates the workspace's connector state
- Incident (war room) creation is recorded against the right project
- The REST router wires all of the above and fails closed on an unknown project
"""

from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from app.domain.services.projects import ProjectNotFoundError, ProjectsService
from app.main import app


class TestProjectsService(unittest.IsolatedAsyncioTestCase):
    """
    Domain service tests, isolated from the seeded singleton.

    `test_connector` is async: Prometheus and Loki are now genuinely probed
    over HTTP (see `_probe_live` in `projects.py`) rather than simulated —
    hence `IsolatedAsyncioTestCase` and the mocked `httpx.AsyncClient` below
    for the two providers that make a real call.
    """

    def setUp(self) -> None:
        self.service = ProjectsService()

    def test_seeded_project_is_listed(self) -> None:
        projects = self.service.list_projects()
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]["id"], "proj-payments")
        self.assertEqual(projects[0]["memberCount"], 3)

    def test_get_project_matches_list(self) -> None:
        project = self.service.get_project("proj-payments")
        self.assertIsNotNone(project)
        self.assertEqual(project["slug"], "payments-core")
        self.assertIn("datadog", project["connectors"])

    def test_get_unknown_project_returns_none(self) -> None:
        self.assertIsNone(self.service.get_project("does-not-exist"))

    def test_save_connector_marks_configured(self) -> None:
        connector = self.service.save_connector(
            "proj-payments",
            {"provider": "cloudwatch", "region": "us-west-2", "secret": "abcd1234"},
        )
        self.assertEqual(connector["status"], "CONFIGURED")
        self.assertEqual(connector["region"], "us-west-2")
        self.assertEqual(connector["authMasked"], "****1234")

    def test_save_connector_unknown_project_raises(self) -> None:
        with self.assertRaises(ProjectNotFoundError):
            self.service.save_connector("does-not-exist", {"provider": "slack"})

    async def test_test_connector_simulated_provider_with_endpoint_connects(self) -> None:
        """Datadog/CloudWatch have no real credential in this checkout, so they
        stay on the simulated path — this is that path, unaffected by the
        Prometheus/Loki live-probe change."""
        result = await self.service.test_connector(
            "proj-payments", {"provider": "datadog", "endpoint": "https://api.datadoghq.com"}
        )
        self.assertEqual(result["status"], "CONNECTED")
        self.assertIsInstance(result["latencyMs"], int)
        self.assertIsInstance(result["metricsDiscovered"], int)

    async def test_test_connector_without_endpoint_or_existing_config_errors(self) -> None:
        result = await self.service.test_connector("proj-payments", {"provider": "totally-new-provider"})
        self.assertEqual(result["status"], "ERROR")
        self.assertIsNone(result["metricsDiscovered"])

    async def test_test_connector_prometheus_live_probe_success(self) -> None:
        """Prometheus is on the LIVE path: a real HTTP GET against `/-/healthy`
        (and a bonus `/api/v1/label/__name__/values` count), not a simulation."""
        fake_health = MagicMock(status_code=200)
        fake_health.raise_for_status = MagicMock()
        fake_names = MagicMock(status_code=200)
        fake_names.json = MagicMock(return_value={"data": ["up", "echo_redis_memory_utilization_pct"]})

        fake_client = MagicMock()
        fake_client.get = AsyncMock(side_effect=[fake_health, fake_names])
        fake_client.__aenter__ = AsyncMock(return_value=fake_client)
        fake_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.domain.services.projects.httpx.AsyncClient", return_value=fake_client):
            result = await self.service.test_connector(
                "proj-payments", {"provider": "prometheus", "endpoint": "http://localhost:9090"}
            )
        self.assertEqual(result["status"], "CONNECTED")
        self.assertEqual(result["metricsDiscovered"], 2)
        self.assertIn("real HTTP probe", result["message"])

    async def test_test_connector_prometheus_live_probe_unreachable(self) -> None:
        """An endpoint that genuinely doesn't answer must report ERROR, not a
        simulated success — this is the whole point of making it live."""
        fake_client = MagicMock()
        fake_client.get = AsyncMock(side_effect=ConnectionError("connection refused"))
        fake_client.__aenter__ = AsyncMock(return_value=fake_client)
        fake_client.__aexit__ = AsyncMock(return_value=False)

        with patch("app.domain.services.projects.httpx.AsyncClient", return_value=fake_client):
            result = await self.service.test_connector(
                "proj-payments", {"provider": "prometheus", "endpoint": "http://localhost:9999"}
            )
        self.assertEqual(result["status"], "ERROR")
        self.assertIsNone(result["metricsDiscovered"])

    def test_create_incident_appends_active_incident(self) -> None:
        incident = self.service.create_incident(
            "proj-payments", {"title": "Checkout 5xx spike", "severity": 1, "channel": "inc-7001"}
        )
        self.assertEqual(incident["channel"], "inc-7001")
        self.assertEqual(incident["status"], "ACTIVE")

        project = self.service.get_project("proj-payments")
        self.assertEqual(len(project["activeIncidents"]), 1)
        self.assertEqual(project["activeIncidents"][0]["id"], incident["id"])

    def test_create_incident_unknown_project_raises(self) -> None:
        with self.assertRaises(ProjectNotFoundError):
            self.service.create_incident(
                "does-not-exist", {"title": "x", "severity": 1, "channel": "inc-1"}
            )


class TestProjectsRouter(unittest.TestCase):
    """REST surface, against the app's shared singleton service."""

    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_list_projects(self) -> None:
        res = self.client.get("/projects")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(any(p["id"] == "proj-payments" for p in body["projects"]))

    def test_get_project_ok(self) -> None:
        res = self.client.get("/projects/proj-payments")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["project"]["id"], "proj-payments")

    def test_get_project_not_found(self) -> None:
        res = self.client.get("/projects/does-not-exist")
        self.assertEqual(res.status_code, 404)

    def test_create_incident_via_router(self) -> None:
        res = self.client.post(
            "/projects/proj-payments/incidents",
            json={"title": "Router test incident", "severity": 2, "channel": "inc-router-1"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["incident"]["channel"], "inc-router-1")

    def test_create_incident_unknown_project_404s(self) -> None:
        res = self.client.post(
            "/projects/does-not-exist/incidents",
            json={"title": "x", "severity": 1, "channel": "inc-x"},
        )
        self.assertEqual(res.status_code, 404)

    def test_test_connector_via_router(self) -> None:
        res = self.client.post(
            "/projects/proj-payments/connectors/test",
            json={"provider": "datadog", "endpoint": "https://api.datadoghq.com"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "CONNECTED")


if __name__ == "__main__":
    unittest.main()
