"""
Tests for Post-Mortem & SOC2 Audit Generator (Domain Policy).
"""

import unittest
from app.domain.ledger import Ledger
from app.domain.models import Claim, Contradiction, Entity, Task, TimelineEvent
from app.domain.policies.authorization import AuditEntry
from app.domain.policies.postmortem import generate_markdown_report, generate_postmortem


class TestPostMortemGenerator(unittest.TestCase):
    def setUp(self) -> None:
        self.ledger = Ledger(incident_id="INC-4417", channel="inc-4417", started_at=1700000000000)
        self.ledger.phase = "investigating"
        self.ledger.rti = 0.65

        # Entities
        self.ledger.entities["e1"] = Entity(
            id="e1", label="Redis Primary", kind="datastore", status="DEGRADED", metric="memory: 85%"
        )

        # Claims
        self.ledger.claims["c1"] = Claim(
            id="c1",
            text="Redis memory is at 85 percent",
            epistemic_status="OBSERVED",
            speaker_role="DevOps Lead",
            confidence=0.95,
            entity="e1",
            speaker_name="Bob Smith",
            speaker_user_id="user_devops_02",
            at=1700000010000,
        )
        self.ledger.claims["c2"] = Claim(
            id="c2",
            text="Database connection pool might be exhausted",
            epistemic_status="HYPOTHESIS",
            speaker_role="Site Reliability Engineer",
            confidence=0.60,
            speaker_name="Carol Danvers",
            speaker_user_id="user_sre_03",
            at=1700000020000,
        )

        # Timeline
        self.ledger.timeline.append(
            TimelineEvent(
                id="t1",
                kind="signal",
                text="Latency spike detected on checkout",
                actor="System",
                at=1700000005000,
            )
        )
        self.ledger.timeline.append(
            TimelineEvent(
                id="t2",
                kind="decision",
                text="Alice Chen approved runbook execution INC-0001",
                actor="Incident Commander",
                actor_name="Alice Chen",
                actor_user_id="user_ic_01",
                at=1700000030000,
            )
        )

        # Contradiction
        self.ledger.contradictions["k1"] = Contradiction(
            id="k1",
            claim_a="c1",
            claim_b="c2",
            speakers=["DevOps Lead", "Site Reliability Engineer"],
            resolved=False,
            at=1700000025000,
            relation="OPPOSED",
            why="Contradiction regarding root bottleneck subsystem",
        )

        # Task
        self.ledger.tasks["task-1"] = Task(
            id="task-1",
            assignee_role="Database Admin",
            description="Inspect active connection counts on postgres primary",
            status="OPEN",
            ref="INC-0001",
            at=1700000028000,
        )

        # Audit Entry
        self.audit_entries = [
            AuditEntry(
                at=1700000030.0,
                actor=1001,
                action="execute_runbook_script",
                outcome="APPROVED",
                detail="INC-0001 redeemed with valid nonce",
                actor_name="Alice Chen",
                actor_user_id="user_ic_01",
            )
        ]

    def test_postmortem_structure_and_overview(self) -> None:
        report = generate_postmortem(
            self.ledger,
            audit_entries=self.audit_entries,
            now=1700000600000,  # +600s = 10 minutes
        )

        ov = report["overview"]
        self.assertEqual(ov["incidentId"], "INC-4417")
        self.assertEqual(ov["channel"], "inc-4417")
        self.assertEqual(ov["phase"], "INVESTIGATING")
        self.assertEqual(ov["duration"], "10m 0s")
        self.assertEqual(ov["peakRti"], 0.65)
        self.assertEqual(ov["status"], "ACTIVE")

    def test_epistemic_discipline_invariant(self) -> None:
        """Rule 1: Echo never asserts causation and includes explicit neutrality disclaimer."""
        report = generate_postmortem(self.ledger, audit_entries=self.audit_entries)
        disclaimer = report["epistemicNeutralityDisclaimer"]
        self.assertIn("non-causal", disclaimer.lower())
        self.assertIn("neutrality", disclaimer.lower())

        claims = report["epistemicClaims"]
        self.assertEqual(len(claims["observed"]), 1)
        self.assertEqual(claims["observed"][0]["speakerName"], "Bob Smith")
        self.assertEqual(claims["observed"][0]["speakerUserId"], "user_devops_02")

        self.assertEqual(len(claims["hypothesis"]), 1)
        self.assertEqual(claims["hypothesis"][0]["speakerName"], "Carol Danvers")

    def test_audit_log_carries_human_attribution(self) -> None:
        report = generate_postmortem(self.ledger, audit_entries=self.audit_entries)
        audit = report["auditLog"]
        self.assertEqual(len(audit), 1)
        self.assertEqual(audit[0]["actorName"], "Alice Chen")
        self.assertEqual(audit[0]["actorUserId"], "user_ic_01")
        self.assertEqual(audit[0]["action"], "execute_runbook_script")
        self.assertEqual(audit[0]["outcome"], "APPROVED")

    def test_markdown_report_formatting(self) -> None:
        report = generate_postmortem(self.ledger, audit_entries=self.audit_entries, now=1700000600000)
        md = generate_markdown_report(report)

        self.assertIn("# Incident Post-Mortem Report: INC-4417", md)
        self.assertIn("## 1. Executive Summary", md)
        self.assertIn("## 2. Impacted Topology & Subsystems", md)
        self.assertIn("## 3. Attributed Chronological Timeline", md)
        self.assertIn("## 4. Epistemic Evidence Ledger", md)
        self.assertIn("## 5. Contradiction & Model Deliberation Analysis", md)
        self.assertIn("## 6. SOC2 Action Gate & Governance Audit Log", md)
        self.assertIn("Bob Smith (DevOps Lead)", md)
        self.assertIn("Alice Chen (user_ic_01)", md)
        self.assertIn("Epistemic Discipline Disclaimer", md)

    def test_api_endpoint(self) -> None:
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        res = client.get("/incident/postmortem")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("postmortem", data)
        self.assertIn("markdown", data)
        self.assertEqual(data["postmortem"]["overview"]["incidentId"], "INC-4417")

        res_md = client.get("/incident/postmortem/markdown")
        self.assertEqual(res_md.status_code, 200)
        self.assertIn("# Incident Post-Mortem Report", res_md.text)


if __name__ == "__main__":
    unittest.main()
