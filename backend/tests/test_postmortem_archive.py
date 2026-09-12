import unittest
from fastapi.testclient import TestClient

from app.main import app
from app.application.services.session import registry
from app.domain.models import Claim, TimelineEvent, now_ms


class TestPostmortemArchival(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.channel = "inc-archive-test"

    def test_postmortem_auto_archived_on_reset(self) -> None:
        # Populate session with claims and timeline
        session = registry.get_or_create(self.channel)
        session.ledger.upsert_claim(Claim(
            id="claim-arch-1",
            text="Service auth is failing with 503.",
            epistemic_status="FACT",
            speaker_role="DevOps Lead",
            confidence=1.0,
            entity="auth",
            at=now_ms(),
        ))
        session.ledger.add_timeline(TimelineEvent(
            id="tl-arch-1",
            kind="observation",
            text="Service auth degraded",
            actor="DevOps Lead",
            at=now_ms(),
        ))

        # Reset the incident
        res = self.client.post(f"/incident/reset?channel={self.channel}")
        self.assertEqual(res.status_code, 200)

        # Check that archives endpoint lists the archived incident
        res = self.client.get(f"/incident/archives?channel={self.channel}")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertGreaterEqual(data["count"], 1)
        archive_id = data["archives"][0]["archiveId"]

        # Fetch the full archived report
        res_arch = self.client.get(f"/incident/archives/{archive_id}")
        self.assertEqual(res_arch.status_code, 200)
        arch_data = res_arch.json()
        self.assertEqual(arch_data["channel"], self.channel)
        self.assertIn("report", arch_data)
        self.assertIn("markdown", arch_data)
        self.assertIn("Post-Mortem", arch_data["markdown"])

        # Fetch raw markdown
        res_md = self.client.get(f"/incident/archives/{archive_id}/markdown")
        self.assertEqual(res_md.status_code, 200)
        self.assertIn("text/markdown", res_md.headers["content-type"])
        self.assertIn("Post-Mortem", res_md.text)


if __name__ == "__main__":
    unittest.main()

