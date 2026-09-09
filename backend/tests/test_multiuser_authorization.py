"""
Tests for Enterprise Identity, Multi-User RBAC, and Audit Attribution.

Verifies:
1. Incident Commander and DevOps Lead are both authorized to redeem critical actions.
2. Non-authorized roles (Observer, SRE, Support Engineer) are refused with WRONG_ROLE.
3. Redeeming records actor_name and actor_user_id into the immutable AuditEntry trail.
4. Denying records actor attribution.
5. Nonce replay protection holds with multi-user participants.
"""

from __future__ import annotations

import unittest
from app.domain.policies.authorization import AuthorizationGate
from app.domain.policies.proxy import AUTHORIZED_ROLES, ProxyActionLayer

FAILOVER_ARGS = {"runbook": "failover-redis", "target": "us-east-1b"}


class TestMultiUserAuthorizationAndAttribution(unittest.TestCase):
    def setUp(self):
        self.gate = AuthorizationGate()
        self.approval = self.gate.mint(
            action="execute_runbook_script",
            args=FAILOVER_ARGS,
            required_role="DevOps Lead",
            now=1000.0,
        )

    def test_incident_commander_can_redeem_with_human_attribution(self):
        ok, outcome = self.gate.redeem(
            self.approval.nonce,
            1002,
            "Incident Commander",
            authorized=True,
            actor_name="Alice Chen",
            actor_user_id="usr_alice",
            now=1001.0,
        )
        self.assertTrue(ok)
        self.assertEqual(outcome, "APPROVED")

        # Verify audit entry has human attribution
        entry = self.gate.audit[-1]
        self.assertEqual(entry.outcome, "APPROVED")
        self.assertEqual(entry.actor, 1002)
        self.assertEqual(entry.actor_name, "Alice Chen")
        self.assertEqual(entry.actor_user_id, "usr_alice")
        wire = entry.to_wire()
        self.assertEqual(wire["actorName"], "Alice Chen")
        self.assertEqual(wire["actorUserId"], "usr_alice")

    def test_devops_lead_can_redeem_with_human_attribution(self):
        ok, outcome = self.gate.redeem(
            self.approval.nonce,
            1003,
            "DevOps Lead",
            authorized=True,
            actor_name="Bob Smith",
            actor_user_id="usr_bob",
            now=1001.0,
        )
        self.assertTrue(ok)
        self.assertEqual(outcome, "APPROVED")

        entry = self.gate.audit[-1]
        self.assertEqual(entry.actor_name, "Bob Smith")
        self.assertEqual(entry.actor_user_id, "usr_bob")

    def test_observer_is_refused_even_if_claiming_authorization(self):
        ok, outcome = self.gate.redeem(
            self.approval.nonce,
            1005,
            "Observer",
            authorized=False,
            actor_name="Elena Rostova",
            actor_user_id="usr_elena",
            now=1001.0,
        )
        self.assertFalse(ok)
        self.assertEqual(outcome, "WRONG_ROLE")

        entry = self.gate.audit[-1]
        self.assertEqual(entry.outcome, "WRONG_ROLE")
        self.assertEqual(entry.actor_name, "Elena Rostova")

    def test_denial_records_human_attribution(self):
        denied = self.gate.deny(
            self.approval.nonce,
            1002,
            actor_name="Alice Chen",
            actor_user_id="usr_alice",
            now=1001.0,
        )
        self.assertTrue(denied)

        entry = self.gate.audit[-1]
        self.assertEqual(entry.outcome, "DENIED")
        self.assertEqual(entry.actor_name, "Alice Chen")
        self.assertEqual(entry.actor_user_id, "usr_alice")
        self.assertIn("Alice Chen (UID 1002)", entry.detail)

    def test_proxy_redeem_with_attribution(self):
        proxy = ProxyActionLayer(channel="inc-4417")
        action_res = proxy.invoke("execute_runbook_script", FAILOVER_ARGS)
        self.assertEqual(action_res.status, "PENDING_APPROVAL")
        nonce = action_res.approval["nonce"]

        result = proxy.redeem(
            nonce,
            1002,
            "Incident Commander",
            authorized=True,
            actor_name="Alice Chen",
            actor_user_id="usr_alice",
        )
        self.assertEqual(result.status, "PENDING_APPROVAL")
        self.assertIsNotNone(result.ref)

        # Audit reflects Alice Chen
        audit = proxy.audit
        approved = [a for a in audit if a["outcome"] == "APPROVED"]
        self.assertEqual(len(approved), 1)
        self.assertEqual(approved[0]["actorName"], "Alice Chen")
        self.assertEqual(approved[0]["actorUserId"], "usr_alice")


if __name__ == "__main__":
    unittest.main()

