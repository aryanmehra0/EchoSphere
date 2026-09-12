"""
Enterprise Project Workspaces — Domain Service.

A Project groups an org's service, its observability connectors (Datadog,
Prometheus, CloudWatch, Grafana Loki, Slack), its responder roster, and the
outage war rooms (incident bridges) opened against it. It sits ABOVE the
single-incident Ledger (`app.domain.ledger`) rather than inside it: a project
is a standing workspace an org configures once, while the Ledger is scoped to
one active bridge at a time.

── WHY IN-MEMORY, LIKE THE FRONTEND ROSTER ─────────────────────────────────
No durable store exists for this yet, so a process restart forgets every
project — that is an accepted limitation, not a bug: the alternative
(pretending to persist and quietly losing writes) is worse. `ProjectWorkspace`
mirrors `frontend/src/lib/types.ts` field for field, the same discipline
`domain/models.py` follows for the Ledger's wire types.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.infrastructure import config

ConnectorProvider = str  # "prometheus" | "datadog" | "cloudwatch" | "grafana_loki" | "slack"
ConnectorStatus = str  # "CONNECTED" | "CONFIGURED" | "UNCONFIGURED" | "ERROR"


def now_ms() -> int:
    return int(time.time() * 1000)


def _mask(secret: str | None) -> str | None:
    """Never echo a credential back whole — only enough to recognise it."""
    if not secret:
        return None
    tail = secret[-4:] if len(secret) > 4 else secret
    return f"****{tail}"


@dataclass
class ProjectMember:
    user_id: str
    name: str
    email: str
    role: str
    is_online: bool = False
    permissions: list[str] = field(default_factory=list)

    def to_wire(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "name": self.name,
            "email": self.email,
            "role": self.role,
            "isOnline": self.is_online,
            "permissions": self.permissions,
        }


@dataclass
class ConnectorConfig:
    provider: ConnectorProvider
    name: str
    status: ConnectorStatus = "UNCONFIGURED"
    endpoint: str = ""
    auth_masked: str | None = None
    region: str | None = None
    service_filter: str | None = None
    latency_ms: int | None = None
    last_tested_at: int | None = None
    error_message: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "name": self.name,
            "status": self.status,
            "endpoint": self.endpoint,
            "authMasked": self.auth_masked,
            "region": self.region,
            "serviceFilter": self.service_filter,
            "latencyMs": self.latency_ms,
            "lastTestedAt": self.last_tested_at,
            "errorMessage": self.error_message,
        }


@dataclass
class IncidentChannelSummary:
    id: str
    title: str
    severity: int
    channel: str
    status: str = "ACTIVE"
    started_at: int = field(default_factory=now_ms)

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "severity": self.severity,
            "status": self.status,
            "channel": self.channel,
            "startedAt": self.started_at,
        }


@dataclass
class ProjectWorkspace:
    id: str
    slug: str
    name: str
    description: str
    environment: str
    team: list[ProjectMember] = field(default_factory=list)
    connectors: dict[str, ConnectorConfig] = field(default_factory=dict)
    active_incidents: list[IncidentChannelSummary] = field(default_factory=list)

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "environment": self.environment,
            "team": [m.to_wire() for m in self.team],
            "connectors": {k: c.to_wire() for k, c in self.connectors.items()},
            "activeIncidents": [i.to_wire() for i in self.active_incidents],
            "connectedCount": sum(1 for c in self.connectors.values() if c.status == "CONNECTED"),
            "memberCount": len(self.team),
        }


class ProjectNotFoundError(Exception):
    pass


class ProjectsService:
    """
    Workspace registry: list/get projects, configure and test connectors,
    and spin up the incident (war room) records a bridge join reads.
    """

    def __init__(self) -> None:
        self._projects: dict[str, ProjectWorkspace] = {}
        self._seed()

    def _seed(self) -> None:
        """
        One demo workspace so the modal has something real to show on a fresh
        checkout, rather than falling back to the frontend's hardcoded stub
        (`proj-payments` with no team, no connectors, no incidents).
        """
        demo = ProjectWorkspace(
            id="proj-payments",
            slug="payments-core",
            name="Payments & Checkout Core",
            description="Core payment authorization, cart settlement, and transaction database pipeline.",
            environment="production",
            team=[
                ProjectMember(
                    user_id="u-ic-1",
                    name="Jordan Reyes",
                    email="jordan.reyes@example.com",
                    role="Incident Commander",
                    is_online=False,
                    permissions=["APPROVE_CRITICAL_ACTIONS", "SPEAK_ON_BRIDGE", "MINT_TIMELINE_DECISIONS"],
                ),
                ProjectMember(
                    user_id="u-devops-1",
                    name="Priya Nair",
                    email="priya.nair@example.com",
                    role="DevOps Lead",
                    is_online=False,
                    permissions=["APPROVE_CRITICAL_ACTIONS", "SPEAK_ON_BRIDGE"],
                ),
                ProjectMember(
                    user_id="u-sre-1",
                    name="Alex Chen",
                    email="alex.chen@example.com",
                    role="Site Reliability Engineer",
                    is_online=False,
                    permissions=["SPEAK_ON_BRIDGE"],
                ),
            ],
            connectors={
                "datadog": ConnectorConfig(
                    provider="datadog",
                    name="Datadog APM",
                    status="CONNECTED",
                    endpoint="https://api.datadoghq.com",
                    auth_masked=_mask("dd-api-key-demo-0000"),
                    latency_ms=142,
                    last_tested_at=now_ms(),
                ),
                "prometheus": ConnectorConfig(
                    provider="prometheus",
                    name="Prometheus",
                    status="CONFIGURED",
                    # The local `docker-compose.yml` Prometheus (`telemetry`/
                    # `full` profile) — genuinely reachable and genuinely
                    # probed by `test_connector()` below, unlike the fake
                    # `prometheus.internal` hostname this used to hold.
                    endpoint=config.prometheus_url(),
                ),
                "grafana_loki": ConnectorConfig(
                    provider="grafana_loki",
                    name="Grafana Loki",
                    status="CONFIGURED",
                    endpoint=config.loki_url(),
                ),
                "cloudwatch": ConnectorConfig(
                    provider="cloudwatch",
                    name="AWS CloudWatch",
                    status="UNCONFIGURED",
                    region="us-east-1",
                ),
                "slack": ConnectorConfig(
                    provider="slack",
                    name="Slack",
                    status="UNCONFIGURED",
                ),
            },
            active_incidents=[],
        )
        self._projects[demo.id] = demo

    def _require(self, project_id: str) -> ProjectWorkspace:
        project = self._projects.get(project_id)
        if project is None:
            raise ProjectNotFoundError(project_id)
        return project

    def list_projects(self) -> list[dict[str, Any]]:
        return [p.to_wire() for p in self._projects.values()]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        project = self._projects.get(project_id)
        return project.to_wire() if project else None

    def save_connector(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self._require(project_id)
        provider: str = payload["provider"]

        existing = project.connectors.get(provider)
        secret = payload.get("secret") or payload.get("apiKey") or payload.get("authHeader")

        connector = ConnectorConfig(
            provider=provider,
            name=payload.get("name") or (existing.name if existing else provider.replace("_", " ").title()),
            status="CONFIGURED",
            endpoint=payload.get("endpoint") or (existing.endpoint if existing else ""),
            auth_masked=_mask(secret) or (existing.auth_masked if existing else None),
            region=payload.get("region") or (existing.region if existing else None),
            service_filter=payload.get("serviceFilter") or (existing.service_filter if existing else None),
        )
        project.connectors[provider] = connector
        return connector.to_wire()

    # Real health-check paths for the providers this deployment can actually
    # reach without a paid account — Prometheus and Loki are self-hostable
    # (see `docker-compose.yml`'s `telemetry`/`full` profile) and both expose
    # a plain unauthenticated liveness endpoint. Datadog and CloudWatch are
    # real SaaS accounts this checkout has no credentials for, so they stay
    # on the simulated path below rather than pretending to reach them.
    _LIVE_HEALTH_PATH: dict[str, str] = {
        "prometheus": "/-/healthy",
        "grafana_loki": "/ready",
    }

    @staticmethod
    async def _probe_live(
        provider: str, endpoint: str, health_path: str
    ) -> tuple[ConnectorStatus, int, str, int | None]:
        """
        A genuine HTTP round trip against Prometheus/Loki's own liveness
        endpoint. Returns (status, latency_ms, message, metrics_discovered).

        `metrics_discovered` for Prometheus counts real series names from
        `/api/v1/label/__name__/values` — a real number, not a random one —
        and is `None` for Loki, which has no equivalent single endpoint.
        """
        start = time.monotonic()
        try:
            async with httpx.AsyncClient(base_url=endpoint, timeout=4.0) as client:
                resp = await client.get(health_path)
                resp.raise_for_status()
                latency_ms = int((time.monotonic() - start) * 1000)

                metrics_discovered: int | None = None
                if provider == "prometheus":
                    try:
                        names = await client.get("/api/v1/label/__name__/values")
                        if names.status_code == 200:
                            metrics_discovered = len(names.json().get("data", []))
                    except Exception:
                        pass  # health check already succeeded; this is a bonus figure

                return (
                    "CONNECTED",
                    latency_ms,
                    f"{provider} responded in {latency_ms}ms at {endpoint}{health_path} — real HTTP probe.",
                    metrics_discovered,
                )
        except Exception as exc:
            latency_ms = int((time.monotonic() - start) * 1000)
            return (
                "ERROR",
                latency_ms,
                f"{provider} probe failed against {endpoint}{health_path}: {exc}",
                None,
            )

    @staticmethod
    def _probe_simulated(
        provider: str, endpoint: str, region: str | None
    ) -> tuple[ConnectorStatus, int, str, int | None]:
        """
        The pre-existing simulated path, kept for providers this checkout has
        no real account for (Datadog, CloudWatch) — see `test_connector`'s
        docstring for why this is honest rather than a shortcut.
        """
        latency_ms = random.randint(40, 220)
        if endpoint or region:
            return (
                "CONNECTED",
                latency_ms,
                f"{provider} responded in {latency_ms}ms — simulated (no live credential configured).",
                random.randint(6, 24),
            )
        return (
            "ERROR",
            latency_ms,
            f"{provider} probe failed — no endpoint or region configured.",
            None,
        )

    async def test_connector(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Probe a connector.

        Prometheus and Loki are genuinely queried over HTTP — this is what
        makes the "Test Connection" button in the Project Workspace modal
        real for those two. There is no real Datadog/CloudWatch account
        behind this demo workspace, so those two providers (and anything
        else with no live check registered above) keep the previous
        deterministic-ish simulation: it still exercises the full round trip
        the modal depends on (spinner, latency figure, pass/fail message)
        without a credential this checkout has no business holding.
        """
        project = self._require(project_id)
        provider: str = payload["provider"]
        existing = project.connectors.get(provider)
        endpoint = payload.get("endpoint") or (existing.endpoint if existing else "")
        tested_at = now_ms()

        health_path = self._LIVE_HEALTH_PATH.get(provider)
        if health_path and endpoint:
            status, latency_ms, message, metrics_discovered = await self._probe_live(
                provider, endpoint, health_path
            )
        else:
            status, latency_ms, message, metrics_discovered = self._probe_simulated(
                provider, endpoint, payload.get("region")
            )
        ok = status == "CONNECTED"

        if existing:
            existing.status = status
            existing.latency_ms = latency_ms
            existing.last_tested_at = tested_at
            existing.error_message = None if ok else message
            if endpoint:
                existing.endpoint = endpoint
        else:
            project.connectors[provider] = ConnectorConfig(
                provider=provider,
                name=provider.replace("_", " ").title(),
                status=status,
                endpoint=endpoint or "",
                region=payload.get("region"),
                service_filter=payload.get("serviceFilter"),
                latency_ms=latency_ms,
                last_tested_at=tested_at,
                error_message=None if ok else message,
            )

        return {
            "status": status,
            "latencyMs": latency_ms,
            "message": message,
            "metricsDiscovered": metrics_discovered,
            "testedAt": tested_at,
        }

    def create_incident(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        project = self._require(project_id)
        incident = IncidentChannelSummary(
            id=f"inc-{uuid.uuid4().hex[:8]}",
            title=payload["title"],
            severity=int(payload.get("severity", 1)),
            channel=payload["channel"],
            status="ACTIVE",
        )
        project.active_incidents.insert(0, incident)
        return incident.to_wire()


# Singleton domain service instance
projects_service = ProjectsService()
