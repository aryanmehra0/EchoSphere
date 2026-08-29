"""
Zone 3 configuration — v6 §10.1.

Read lazily, never at import, for the same reason Zone 2 does it: a missing key
must fail the one request that needs it with an actionable message, not crash a
process that is otherwise perfectly able to serve the dashboard.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# backend/.env first, then the frontend's .env.local as a fallback so a single
# filled-in file can drive both processes during development. The frontend file
# is gitignored and already holds the Agora + Groq + TTS credentials.
_BACKEND_ENV = Path(__file__).resolve().parent.parent / ".env"
_FRONTEND_ENV = Path(__file__).resolve().parent.parent.parent / "frontend" / ".env.local"

load_dotenv(_BACKEND_ENV)
load_dotenv(_FRONTEND_ENV)


class MissingEnv(RuntimeError):
    """Raised when a required credential is absent, with a fix-it message."""

    def __init__(self, name: str) -> None:
        super().__init__(
            f"Missing required environment variable: {name}\n"
            f"Add it to backend/.env (or frontend/.env.local) — see .env.example."
        )


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise MissingEnv(name)
    return value


def _optional(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


@dataclass(frozen=True)
class AgoraSettings:
    app_id: str
    customer_id: str
    customer_secret: str
    api_base: str

    @property
    def conv_ai_base(self) -> str:
        return f"{self.api_base}/api/conversational-ai-agent/v2/projects/{self.app_id}"


def agora() -> AgoraSettings:
    return AgoraSettings(
        app_id=_required("AGORA_APP_ID"),
        customer_id=_required("AGORA_CUSTOMER_ID"),
        customer_secret=_required("AGORA_CUSTOMER_SECRET"),
        api_base=_optional("AGORA_API_BASE", "https://api.agora.io"),
    )


def groq_api_key() -> str:
    return _required("GROQ_API_KEY")


def analysis_model() -> str:
    """
    The Slow Loop model.

    Separate from the Fast Loop's model on purpose: this one runs against a 4 s
    budget (§12.2) rather than a conversational one, so it can afford to be the
    more careful reasoner. Extraction quality and adjudication precision matter
    more here than time-to-first-token.
    """
    return _optional("ANALYSIS_MODEL", "openai/gpt-oss-120b")


def observer_mode() -> str:
    """
    'ingress' — transcripts arrive over HTTP (works on any Python).
    'agora'   — real per-UID audio via the Agora Python SDK (needs <= 3.12).

    See requirements.txt for why the default is not 'agora'.
    """
    return _optional("OBSERVER_MODE", "ingress")


def credential_status() -> dict[str, bool]:
    """Presence only, never values — same contract as Zone 2's /api/health."""
    def present(name: str) -> bool:
        return bool(os.getenv(name, "").strip())

    return {
        "AGORA_APP_ID": present("AGORA_APP_ID"),
        "AGORA_CUSTOMER_ID": present("AGORA_CUSTOMER_ID"),
        "AGORA_CUSTOMER_SECRET": present("AGORA_CUSTOMER_SECRET"),
        "GROQ_API_KEY": present("GROQ_API_KEY"),
    }
