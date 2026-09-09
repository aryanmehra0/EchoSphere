import hashlib
import hmac
import time
import unittest
from unittest.mock import MagicMock

from app.web.middleware import is_local, verify_hmac, _is_rate_limited


class TestGatewaySecurity(unittest.TestCase):
    def test_is_local(self) -> None:
        self.assertTrue(is_local("localhost"))
        self.assertTrue(is_local("localhost:8000"))
        self.assertTrue(is_local("127.0.0.1"))
        self.assertTrue(is_local("127.0.0.1:8000"))
        self.assertTrue(is_local("[::1]:8000"))
        self.assertFalse(is_local("tunnel.ngrok-free.app"))
        self.assertFalse(is_local("echosphere.internal.net"))

    def test_verify_hmac_valid_signature(self) -> None:
        secret = "test-secret-key-12345"
        now_s = int(time.time())
        path = "/tools/query_incident_state"
        method = "POST"
        msg = f"{now_s}.{method}.{path}"
        sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

        mock_request = MagicMock()
        mock_request.headers.get.side_effect = lambda k, default="": {
            "x-echo-signature": sig,
            "x-echo-timestamp": str(now_s),
        }.get(k.lower(), default)
        mock_request.method = method
        mock_request.url.path = path

        self.assertTrue(verify_hmac(mock_request, secret))

    def test_verify_hmac_expired_timestamp_rejected(self) -> None:
        secret = "test-secret-key-12345"
        # 400 seconds ago (expired, limit is 300s)
        old_time_s = int(time.time()) - 400
        path = "/tools/query_incident_state"
        method = "POST"
        msg = f"{old_time_s}.{method}.{path}"
        sig = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

        mock_request = MagicMock()
        mock_request.headers.get.side_effect = lambda k, default="": {
            "x-echo-signature": sig,
            "x-echo-timestamp": str(old_time_s),
        }.get(k.lower(), default)
        mock_request.method = method
        mock_request.url.path = path

        self.assertFalse(verify_hmac(mock_request, secret))

    def test_verify_hmac_tampered_signature_rejected(self) -> None:
        secret = "test-secret-key-12345"
        now_s = int(time.time())
        path = "/tools/query_incident_state"
        method = "POST"

        mock_request = MagicMock()
        mock_request.headers.get.side_effect = lambda k, default="": {
            "x-echo-signature": "tampered-bogus-signature",
            "x-echo-timestamp": str(now_s),
        }.get(k.lower(), default)
        mock_request.method = method
        mock_request.url.path = path

        self.assertFalse(verify_hmac(mock_request, secret))

    def test_rate_limiter_triggers_after_threshold(self) -> None:
        ip = "192.168.1.99"
        # Within limit: 50 requests
        for _ in range(50):
            self.assertFalse(_is_rate_limited(ip, limit=50, window=1.0))
        # 51st request is blocked
        self.assertTrue(_is_rate_limited(ip, limit=50, window=1.0))


if __name__ == "__main__":
    unittest.main()

