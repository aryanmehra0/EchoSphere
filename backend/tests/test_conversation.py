"""
The conversational path — the parts that decide whether a human can actually
talk to Echo and get an answer.

Two things are asserted here, and both were live defects:

  1. Echo announces itself on joining. It used to join in total silence, which
     from inside the room is indistinguishable from a failed invite, a wrong
     channel, or a mute TTS vendor.

  2. The tunnel gate. Agora calls our REST tools from its own servers, so the
     Slow Loop has to be publicly reachable — which exposes `/incident/reset`
     and `/bridge/say` along with it. A tunnel hostname is obscurity, not
     authentication.

Run:  .venv/Scripts/python -m unittest discover -s tests -t .
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient

# Imported at MODULE level on purpose, not inside the tests.
#
# `app.config` calls `load_dotenv()` at import. If that import first happens
# inside a `mock.patch.dict(os.environ, ...)` block, the variables dotenv adds
# are seen as part of the patch — and restoring on exit DELETES every
# credential, so `/health` starts reporting 503 in whichever test happens to
# run next. Cost an afternoon; keep the import up here.
from app.main import app
from app.utterance import EpistemicViolation, joined, validate


class JoinAnnouncement(unittest.TestCase):
    """§6 applies to the first sentence too — especially the first sentence."""

    def test_both_variants_pass_the_epistemic_gate(self) -> None:
        for can_read in (True, False):
            with self.subTest(can_read_ledger=can_read):
                # joined() calls validate() internally; this asserts it stays
                # that way if someone rewrites the wording later.
                self.assertEqual(
                    joined(can_read_ledger=can_read),
                    validate(joined(can_read_ledger=can_read)),
                )

    def test_it_says_whether_the_record_is_readable(self) -> None:
        """
        The honest half. Without tools Echo cannot answer a factual question,
        and saying so on arrival is worth more than a refusal twenty minutes
        later when somebody actually needs an answer.
        """
        self.assertNotIn("cannot read", joined(can_read_ledger=True))
        self.assertIn("cannot read the record", joined(can_read_ledger=False))

    def test_it_claims_nothing_about_the_incident(self) -> None:
        """
        A greeting reports Echo's own state. If it ever starts describing the
        incident it needs attribution like anything else, and the `_NO_CLAIM`
        prefix allowance would be hiding a Rule 1 violation rather than
        correctly exempting a non-claim.
        """
        for can_read in (True, False):
            line = joined(can_read_ledger=can_read).lower()
            for leak in ("redis", "latency", "checkout", "error", "incident is"):
                self.assertNotIn(leak, line)

    def test_a_diagnosing_greeting_is_still_refused(self) -> None:
        """The allowance is a prefix, not an amnesty — Rule 2 still applies."""
        with self.assertRaises(EpistemicViolation):
            validate("Echo is on the bridge. The root cause is Redis eviction.")


class TunnelGate(unittest.TestCase):
    """
    Local traffic untouched; remote traffic must present the token.

    Fail-closed is the important half: with a tunnel open and no secret set,
    refusing is correct and serving is a public unauthenticated control
    surface that looks like it is working.
    """

    def _client(self) -> TestClient:
        return TestClient(app)

    def test_localhost_is_never_challenged(self) -> None:
        with mock.patch.dict(os.environ, {"AGENT_TOOL_SECRET": "s3cret"}):
            with self._client() as c:
                r = c.get("/health", headers={"host": "127.0.0.1:8000"})
                self.assertNotIn(r.status_code, (401, 503))

    def test_remote_tool_call_without_a_token_is_refused(self) -> None:
        with mock.patch.dict(os.environ, {"AGENT_TOOL_SECRET": "s3cret"}):
            with self._client() as c:
                r = c.post(
                    "/tools/query_incident_state",
                    json={},
                    headers={"host": "abc-def.trycloudflare.com"},
                )
                self.assertEqual(r.status_code, 401)

    def test_remote_tool_call_with_the_token_is_admitted(self) -> None:
        with mock.patch.dict(os.environ, {"AGENT_TOOL_SECRET": "s3cret"}):
            with self._client() as c:
                r = c.post(
                    "/tools/query_incident_state",
                    json={},
                    headers={
                        "host": "abc-def.trycloudflare.com",
                        "x-echo-tool-token": "s3cret",
                    },
                )
                self.assertNotIn(r.status_code, (401, 503))

    def test_a_wrong_token_is_refused(self) -> None:
        with mock.patch.dict(os.environ, {"AGENT_TOOL_SECRET": "s3cret"}):
            with self._client() as c:
                r = c.post(
                    "/bridge/say",
                    json={"text": "anything"},
                    headers={
                        "host": "abc-def.trycloudflare.com",
                        "x-echo-tool-token": "wrong",
                    },
                )
                self.assertEqual(r.status_code, 401)

    def test_remote_is_refused_outright_when_no_secret_is_configured(self) -> None:
        """
        Fail closed. An unset secret means the operator did not intend remote
        access, so a tunnel someone left open cannot silently become a way to
        make Echo say things on a live bridge.
        """
        with mock.patch.dict(os.environ, {"AGENT_TOOL_SECRET": ""}):
            with self._client() as c:
                r = c.post(
                    "/bridge/say",
                    json={"text": "anything"},
                    headers={"host": "abc-def.trycloudflare.com"},
                )
                self.assertEqual(r.status_code, 503)

    def test_health_answers_through_the_tunnel_unauthenticated(self) -> None:
        """
        Deliberate exception. `/health` reports presence, never values, and
        being able to ask "is the tunnel actually routing?" without a token is
        worth more than hiding it — `start.ps1` probes exactly this.
        """
        with mock.patch.dict(os.environ, {"AGENT_TOOL_SECRET": "s3cret"}):
            with self._client() as c:
                r = c.get("/health", headers={"host": "abc-def.trycloudflare.com"})
                self.assertNotIn(r.status_code, (401, 503))


class Registration(unittest.TestCase):
    """
    Re-registration is expected, and must be safe.

    Zone 2's invite is idempotent per channel, but the agent id lives in THIS
    process's memory. A backend restart forgets it while Zone 2 still says
    "already handled" - so without re-registration Echo stayed mute for the
    rest of the session with no way back short of a new channel. Reported
    live, along with its twin: the reuse path returned no
    `registeredWithSlowLoop`, so the console read undefined, took it for
    false, and raised "ECHO CANNOT SPEAK" over an Echo that was working.
    """

    def setUp(self) -> None:
        # The agent record lives on the incident session now, not in a module
        # global. Reached through the registry so this sees the same object the
        # route handler will.
        from app.services.session import registry

        agent = registry.current().agent
        self._saved = dict(agent)
        agent["agent_id"] = None
        agent["channel"] = None

    def tearDown(self) -> None:
        from app.services.session import registry

        registry.current().agent.update(self._saved)

    def _register(self, client: TestClient, **body: object) -> dict:
        payload = {"agentId": "AGENT-1", "channel": "inc-4417", **body}
        # TestClient sends `Host: testserver`, which the tunnel gate correctly
        # treats as remote and refuses. Registration is a local call in real
        # life - Zone 2 runs on the same machine - so say so.
        return client.post(
            "/agent/register", json=payload, headers={"host": "127.0.0.1:8000"}
        ).json()

    def test_a_new_agent_is_announced(self) -> None:
        with TestClient(app) as c:
            with mock.patch("app.services.speech.BridgeController") as bridge:
                bridge.return_value.__aenter__.return_value.speak = mock.AsyncMock()
                out = self._register(c)
        self.assertTrue(out["ok"])
        self.assertEqual(out["agent"]["agent_id"], "AGENT-1")

    def test_registering_the_same_agent_again_does_not_re_announce(self) -> None:
        """Echo introducing itself on every reload is the filler §14.1 bans."""
        with TestClient(app) as c:
            with mock.patch("app.services.speech.BridgeController") as bridge:
                bridge.return_value.__aenter__.return_value.speak = mock.AsyncMock()
                self._register(c)
                again = self._register(c)
        self.assertFalse(again["greeting"]["spoken"])
        self.assertEqual(again["greeting"]["reason"], "already registered")

    def test_greet_false_suppresses_the_announcement(self) -> None:
        """
        The flag Zone 2 sets on the REUSE path. This process cannot work it
        out for itself: it holds the id in memory, so after a restart every
        agent looks new and Echo would greet a room it has been sitting in.
        """
        with TestClient(app) as c:
            with mock.patch("app.services.speech.BridgeController") as bridge:
                bridge.return_value.__aenter__.return_value.speak = mock.AsyncMock()
                out = self._register(c, greet=False)
        self.assertFalse(out["greeting"]["spoken"])
        self.assertEqual(out["greeting"]["reason"], "not a new session")
        # Registration itself must still have happened - that is the whole
        # point of re-registering after a restart.
        self.assertEqual(out["agent"]["agent_id"], "AGENT-1")

    def test_the_greeting_does_not_interrupt_itself(self) -> None:
        """
        `speak`, not `speak_now`. speak_now interrupts before speaking, and a
        greeting has nothing to pre-empt - it is the first thing said. Live,
        the interrupt raced its own utterance and Agora recorded the arrival
        line truncated to the single word "Echo".
        """
        with TestClient(app) as c:
            with mock.patch("app.services.speech.BridgeController") as bridge:
                entered = bridge.return_value.__aenter__.return_value
                entered.speak = mock.AsyncMock()
                entered.speak_now = mock.AsyncMock()
                self._register(c)
        entered.speak.assert_awaited()
        entered.speak_now.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
