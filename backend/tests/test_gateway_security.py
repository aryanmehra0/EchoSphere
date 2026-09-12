import hashlib
import hmac
import time
import unittest

from starlette.requests import Request

from app.web.middleware import is_local, verify_hmac, _is_rate_limited, is_browser_path


def make_request(
    *,
    client_host: str = "127.0.0.1",
    headers: dict[str, str] | None = None,
    method: str = "POST",
    path: str = "/tools/query_incident_state",
    body: bytes = b"",
) -> Request:
    """A real Starlette `Request` built from a plain ASGI scope — exercises
    the exact attribute access (`request.client.host`, `request.headers`,
    `request.body()`) the middleware actually uses in production, rather than
    a `MagicMock` standing in for behavior that can silently drift from it."""
    hdrs = headers or {}
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in hdrs.items()],
        "client": (client_host, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    }

    async def receive() -> dict:
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive=receive)


class TestGatewaySecurity(unittest.IsolatedAsyncioTestCase):
    def test_is_local_genuinely_local_peer_with_no_cloudflare_headers(self) -> None:
        for host in ("127.0.0.1", "localhost", "::1", "testclient"):
            self.assertTrue(is_local(make_request(client_host=host)), host)

    def test_is_local_rejects_non_loopback_peer(self) -> None:
        # A real remote connection never looks like this at the TCP layer —
        # included for completeness, since a raw scope could claim anything.
        self.assertFalse(is_local(make_request(client_host="203.0.113.7")))

    def test_is_local_host_header_alone_no_longer_grants_bypass(self) -> None:
        """
        The vulnerability this fix closes: `Host` is fully client-controlled,
        and this project's Cloudflare Quick Tunnel forwards it unmodified by
        default. Setting `Host: localhost` must NOT be sufficient on its own
        — the previous implementation trusted exactly this header.
        """
        spoofed = make_request(
            client_host="127.0.0.1",  # cloudflared's own loopback connection
            headers={"host": "localhost", "cf-ray": "8a1b2c3d4e5f6789-SJC"},
        )
        self.assertFalse(is_local(spoofed))

    def test_is_local_any_cloudflare_header_marks_the_request_remote(self) -> None:
        for header in ("cf-ray", "cf-connecting-ip", "cf-visitor"):
            tunneled = make_request(client_host="127.0.0.1", headers={header: "x"})
            self.assertFalse(is_local(tunneled), header)

    async def test_verify_hmac_valid_signature(self) -> None:
        secret = "test-secret-key-12345"
        now_s = int(time.time())
        path = "/tools/query_incident_state"
        method = "POST"
        body = b'{"channel":"inc-1"}'
        body_hash = hashlib.sha256(body).hexdigest()
        msg = f"{now_s}.{method}.{path}.{body_hash}"
        sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

        request = make_request(
            method=method,
            path=path,
            body=body,
            headers={"x-echo-signature": sig, "x-echo-timestamp": str(now_s)},
        )

        self.assertTrue(await verify_hmac(request, secret))

    async def test_verify_hmac_expired_timestamp_rejected(self) -> None:
        secret = "test-secret-key-12345"
        now_s = int(time.time()) - 400  # 400s ago (> 300s window)
        path = "/tools/query_incident_state"
        method = "POST"
        body = b""
        body_hash = hashlib.sha256(body).hexdigest()
        msg = f"{now_s}.{method}.{path}.{body_hash}"
        sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

        request = make_request(
            method=method,
            path=path,
            body=body,
            headers={"x-echo-signature": sig, "x-echo-timestamp": str(now_s)},
        )

        self.assertFalse(await verify_hmac(request, secret))

    async def test_verify_hmac_tampered_signature_rejected(self) -> None:
        secret = "test-secret-key-12345"
        now_s = int(time.time())
        path = "/tools/query_incident_state"
        method = "POST"

        request = make_request(
            method=method,
            path=path,
            headers={"x-echo-signature": "tampered-bogus-signature", "x-echo-timestamp": str(now_s)},
        )

        self.assertFalse(await verify_hmac(request, secret))

    async def test_verify_hmac_tampered_body_rejected(self) -> None:
        """
        The fix in this file: the signature now binds the body too. A
        signature computed over one body must not verify against a different
        one — this is exactly the replay this HMAC path exists to prevent.
        """
        secret = "test-secret-key-12345"
        now_s = int(time.time())
        path = "/tools/invoke"
        method = "POST"
        original_body = b'{"action":"create_jira_ticket","args":{}}'
        body_hash = hashlib.sha256(original_body).hexdigest()
        msg = f"{now_s}.{method}.{path}.{body_hash}"
        sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

        tampered_body = b'{"action":"execute_runbook_script","args":{"script":"failover-redis"}}'
        request = make_request(
            method=method,
            path=path,
            body=tampered_body,
            headers={"x-echo-signature": sig, "x-echo-timestamp": str(now_s)},
        )

        self.assertFalse(await verify_hmac(request, secret))

    async def test_rate_limiter_triggers_after_threshold(self) -> None:
        ip = "192.168.1.99"
        # Within limit: 50 requests
        for _ in range(50):
            self.assertFalse(await _is_rate_limited(ip, limit=50, window=1.0))
        # 51st request is blocked
        self.assertTrue(await _is_rate_limited(ip, limit=50, window=1.0))

    def test_is_browser_path(self) -> None:
        # Only the read-only delta stream is exempt from needing the secret
        # on remote traffic now — every WRITE-capable "console path" used to
        # be exempt too, which is what let a remote caller with no secret
        # inject fabricated transcripts/telemetry into a live incident.
        self.assertTrue(is_browser_path("/ws/deltas"))

        self.assertFalse(is_browser_path("/observer/transcript"))
        self.assertFalse(is_browser_path("/observer/acoustic_telemetry"))
        self.assertFalse(is_browser_path("/projects"))
        self.assertFalse(is_browser_path("/projects/proj-payments"))
        self.assertFalse(is_browser_path("/projects/proj-payments/connectors/test"))
        self.assertFalse(is_browser_path("/telemetry/catalog"))
        self.assertFalse(is_browser_path("/telemetry/probe"))
        self.assertFalse(is_browser_path("/telemetry/matrix"))
        self.assertFalse(is_browser_path("/incident/postmortem"))
        self.assertFalse(is_browser_path("/incident/archives"))
        self.assertFalse(is_browser_path("/incident/search"))

        # Gated agent tools must NOT be open browser paths
        self.assertFalse(is_browser_path("/tools/query_incident_state"))
        self.assertFalse(is_browser_path("/tools/probe_telemetry"))
        self.assertFalse(is_browser_path("/tools/execute_runbook_script"))
        self.assertFalse(is_browser_path("/admin/shutdown"))


if __name__ == "__main__":
    unittest.main()
