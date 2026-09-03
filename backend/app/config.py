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


def groq_api_keys() -> list[str]:
    """
    Every Groq key available, in preference order.

    ── WHY MORE THAN ONE ──────────────────────────────────────────────────
    The free tier's hard limit is 200,000 tokens per DAY, scoped per key AND
    per model. A full demo run costs 15–20k, so a single key is roughly ten
    rehearsals — and a day of debugging spends that before lunch. When it
    goes, nothing announces it: the console joins, the dashboard fills with
    transcripts, Echo sits in the channel, and no claims ever appear because
    every extraction is failing behind the scenes on a 429 nobody is reading.

    A second key doubles the budget outright. `GROQ_API_KEY_2` is optional —
    absent, this returns exactly the single key and behaviour is unchanged.

    Deduplicated because pasting the same key into both slots is an easy
    mistake, and it would silently halve the apparent redundancy: the rotation
    would "fall back" to the key that just failed and report a dead end.
    """
    keys: list[str] = []
    for name in ("GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3"):
        value = os.getenv(name, "").strip()
        if value and value not in keys:
            keys.append(value)
    if not keys:
        raise RuntimeError("GROQ_API_KEY is required")
    return keys


def analysis_models() -> list[str]:
    """
    The Slow Loop model, plus fallbacks — v6 §13's degradation ladder applied
    to the analytical LLM.

    Groq's limits are TOKENS PER DAY and they are scoped PER MODEL. A day of
    measurement exhausted `gpt-oss-120b` (200k TPD) outright, and every call
    then failed with a 429 that no amount of retrying could clear — "try again
    in 21m" against a daily budget is not a wait, it is a wall.

    Because the quota is per model, falling back to another one restores
    service immediately. Ordered best-quality first: the fallbacks are smaller
    and a little worse at the epistemic tagging, which is the right trade
    against a dashboard that has stopped updating entirely.
    """
    primary = _optional("ANALYSIS_MODEL", "openai/gpt-oss-120b")
    fallbacks = [
        m.strip() for m in _optional(
            "ANALYSIS_MODEL_FALLBACKS", "openai/gpt-oss-20b,qwen/qwen3.8-27b"
        ).split(",") if m.strip()
    ]
    return [primary, *[m for m in fallbacks if m != primary]]


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


def tool_secret() -> str:
    """
    Shared secret for tool calls that arrive from outside this machine.

    ── WHY THIS EXISTS ─────────────────────────────────────────────────────
    Agora's Conversational AI Engine calls our REST tools from ITS servers,
    not from the browser. So for `query_incident_state` to work at all, the
    Slow Loop has to be reachable from the public internet — in development,
    through a tunnel.

    That tunnel does not expose one endpoint. It exposes the whole service,
    including `/incident/reset`, `/bridge/say` and `/approval/redeem`. A
    random tunnel hostname is obscurity, not security, and this project's
    own trust-zone rule (Zone 3 holds the analytical keys) does not survive
    "anyone who guesses the URL can make Echo say anything".

    So: requests arriving with a non-local Host must carry this token.
    Requests from localhost are unaffected, which is why the dashboard and
    the Rehearsal Rig keep working exactly as before.
    """
    return _optional("AGENT_TOOL_SECRET", "")
