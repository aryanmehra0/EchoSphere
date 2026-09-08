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
    # Token-signing key. Required by the SDK path (`voice_agent.py`), which
    # mints its own RTC/RTM token rather than being handed one by Zone 2.
    # Empty string when absent so the REST-only paths keep working unchanged.
    app_certificate: str = ""

    @property
    def conv_ai_base(self) -> str:
        return f"{self.api_base}/api/conversational-ai-agent/v2/projects/{self.app_id}"


def agora() -> AgoraSettings:
    return AgoraSettings(
        app_id=_required("AGORA_APP_ID"),
        customer_id=_required("AGORA_CUSTOMER_ID"),
        customer_secret=_required("AGORA_CUSTOMER_SECRET"),
        api_base=_optional("AGORA_API_BASE", "https://api.agora.io"),
        app_certificate=_optional("AGORA_APP_CERTIFICATE", ""),
    )


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

    Returns an EMPTY list rather than raising when no key is set. Raising was
    correct while Groq was the only provider; now a Gemma-only configuration is
    valid, and a hard failure here would refuse to start a bridge that has a
    perfectly good analysis model configured.
    """
    keys: list[str] = []
    for name in ("GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3"):
        value = os.getenv(name, "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


# ---------------------------------------------------------------------------
# Gemma — an OpenAI-compatible second provider
# ---------------------------------------------------------------------------
#
# ── WHY A SECOND PROVIDER AT ALL ────────────────────────────────────────────
# Groq's daily cap is per key AND per model, and when it runs out the failure
# is invisible: the console joins, transcripts flow, Echo sits in the channel,
# and no claims appear because every extraction is dying on a 429. The model
# fallback chain helps, but every entry in it draws from the SAME account, so
# a hard day of rehearsals exhausts all of them together.
#
# Gemma is served from somewhere else entirely — Groq's catalog carries no
# Gemma model at all (checked live), so it has to be. Anything speaking the
# OpenAI chat-completions format works: Ollama, vLLM, LM Studio, llama.cpp,
# or a hosted gateway. A locally hosted model has no quota, which is what
# makes it the useful thing to fall back to.
#
# It is OPT-IN. With no `GEMMA_BASE_URL` and no key, `analysis_providers()`
# returns Groq alone and behaviour is bit-for-bit what it was.

# No public default: unlike a single-vendor cloud API there is no canonical
# host to guess, and guessing one would turn "you forgot to configure it" into
# a confusing connection error against somebody else's server. Absent a base
# URL, Gemma is simply not configured.
GEMMA_DEFAULT_BASE = ""


def gemma_api_keys() -> list[str]:
    """
    Every Gemma key available, in preference order. Empty when unconfigured.

    A LOCAL server usually needs no key at all (Ollama and vLLM typically
    accept anything), so `gemma_enabled()` treats a base URL as sufficient on
    its own and this may legitimately return nothing.
    """
    keys: list[str] = []
    for name in ("GEMMA_API_KEY", "GEMMA_API_KEY_2", "GEMMA_API_KEY_3"):
        value = os.getenv(name, "").strip()
        if value and value not in keys:
            keys.append(value)
    return keys


def gemma_base_url() -> str:
    """
    The OpenAI-compatible endpoint serving Gemma.

    Must include whatever prefix the server mounts chat completions under.
    Most local servers use `/v1`:

        GEMMA_BASE_URL=http://127.0.0.1:8443/v1

    Pointing this at any other OpenAI-shaped server makes that server work
    with no code change, which is the reason it is a URL and not a vendor flag.
    """
    return _optional("GEMMA_BASE_URL", GEMMA_DEFAULT_BASE).rstrip("/")


def gemma_enabled() -> bool:
    """
    Whether Gemma is configured at all.

    A base URL is the requirement; a key is optional on top of it. That
    ordering is deliberate — a local server on 127.0.0.1 usually
    authenticates nothing, so demanding a key would make a working endpoint
    look unconfigured, while an endpoint with no address cannot be called at
    all no matter how many keys are set.
    """
    return bool(gemma_base_url())


def gemma_models() -> list[str]:
    """
    The Gemma model chain, best first.

    ── THE DEFAULT IS THE SERVED ID, NOT THE MODEL'S REAL NAME ─────────────
    `gemma4` looks like a typo and is correct. A vLLM server answers to
    whatever `--served-model-name` it was started with, and the one this was
    developed against reports:

        id   = "gemma4"
        root = "/models/gemma-4-26B-A4B-it"

    Only `id` is a valid `model` value in a request; sending the root path or
    a guessed HuggingFace name gets a 404 from an otherwise healthy server.
    So the default matches what `GET /v1/models` actually advertises, and
    anyone pointing this at a different server overrides it.

    NO FALLBACK BY DEFAULT. A local server typically hosts exactly one model,
    and a second name would just be a guaranteed 404 on the way to giving up —
    which costs a round trip and logs a scary warning for a configuration
    that is working correctly. Set `GEMMA_MODEL_FALLBACKS` when the server
    genuinely serves more than one.
    """
    primary = _optional("GEMMA_MODEL", "gemma4")
    fallbacks = [
        m.strip() for m in _optional("GEMMA_MODEL_FALLBACKS", "").split(",")
        if m.strip()
    ]
    return [primary, *[m for m in fallbacks if m != primary]]


def analysis_provider_order() -> list[str]:
    """
    Which provider to try first, and what to fall back to.

    `ANALYSIS_PROVIDER` accepts:
        "groq"        Groq only (the default, and what shipped before Gemma)
        "gemma"       Gemma only
        "groq,gemma"  Groq first, Gemma when every Groq model is spent
        "gemma,groq"  the reverse — useful when the local box is free and the
                      Groq budget is being saved for the demo

    Unknown names are dropped rather than raising: a typo in an env var should
    not stop the Slow Loop from starting, and `analysis_providers()` reports
    what it actually resolved.
    """
    raw = _optional("ANALYSIS_PROVIDER", "groq")
    order = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return [p for p in order if p in ("groq", "gemma")] or ["groq"]


def analysis_providers() -> list[tuple[str, list[str], list[str]]]:
    """
    The resolved analysis chain: (provider, models, keys), in try order.

    A provider that is not configured is omitted entirely — that is what makes
    Gemma opt-in and keeps a Groq-only machine on exactly its previous
    behaviour. Configuring `ANALYSIS_PROVIDER=gemma,groq` on a box with no
    Gemma endpoint silently yields Groq, which is the right outcome: run with
    what is actually available rather than failing on a preference.
    """
    available: list[tuple[str, list[str], list[str]]] = []
    for provider in analysis_provider_order():
        if provider == "groq":
            keys = groq_api_keys()
            if keys:
                available.append(("groq", analysis_models(), keys))
        elif provider == "gemma" and gemma_enabled():
            # A local server may need no key. One empty-string "key" keeps the
            # rotation loop's shape identical for both cases rather than
            # forcing every caller to special-case an empty list.
            available.append(("gemma", gemma_models(), gemma_api_keys() or [""]))
    return available


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


# `analysis_model()` (singular) and `groq_api_key()` (singular) were removed.
#
# Both were superseded by their plural forms and had no callers left. Keeping
# them was actively misleading: the singular key accessor implied one key when
# rotation across several is what `groq_json` actually does, and the singular
# model accessor implied one model when the fallback chain is the thing that
# keeps the pipeline alive on an exhausted daily quota.
#
# The Slow Loop's model choice is still deliberately separate from the Fast
# Loop's — it runs against a 4s budget rather than a conversational one, so it
# can afford the more careful reasoner. That lives in `analysis_models()`.


def observer_mode() -> str:
    """
    'ingress' — transcripts arrive over HTTP (works on any Python).
    'agora'   — real per-UID audio via the Agora Python SDK (needs <= 3.12).

    See requirements.txt for why the default is not 'agora'.
    """
    return _optional("OBSERVER_MODE", "ingress")


def cors_origins() -> str:
    """
    Additional CORS origins, comma-separated.

    Development defaults are baked into main.py; this is the escape hatch for
    a console that runs on a non-standard port (e.g. :3001 when something else
    owns 3000). Without the browser's origin listed here, the voice path dies
    silently: transcripts never reach /observer/transcript and the dashboard
    never hears a word.
    """
    return _optional("CORS_ORIGINS", "")


def credential_status() -> dict[str, bool]:
    """
    Presence only, never values — same contract as Zone 2's /api/health.

    `GROQ_API_KEY` is reported as its own row because start.ps1, demo.mjs and
    validate.ps1 all read that exact key and would break if it vanished. But
    readiness now hangs on `ANALYSIS_LLM`, which is true when ANY provider is
    configured — a Gemma-only bridge is a valid bridge, and `/health` returning
    503 because one specific vendor's key is absent would refuse to start a
    service that has a working analysis model.
    """
    def present(name: str) -> bool:
        return bool(os.getenv(name, "").strip())

    return {
        "AGORA_APP_ID": present("AGORA_APP_ID"),
        "AGORA_CUSTOMER_ID": present("AGORA_CUSTOMER_ID"),
        "AGORA_CUSTOMER_SECRET": present("AGORA_CUSTOMER_SECRET"),
        # Kept for the existing tooling that greps for this name.
        "GROQ_API_KEY": present("GROQ_API_KEY"),
        # What actually gates readiness.
        "ANALYSIS_LLM": bool(analysis_providers()),
    }


def database_url() -> str:
    """
    Postgres DSN for the Evidence Ledger, or "" when persistence is off.

    ── WHY ABSENCE IS A VALID CONFIGURATION ────────────────────────────────
    The Slow Loop must still run with no database. §17's standing rule is that
    the dashboard never depends on the Fast Loop, and the same reasoning
    applies downward: a demo on a laptop with no Docker should degrade to the
    in-memory Ledger it has always used, not refuse to start.

    So this returns "" rather than raising, and `store.py` treats that as
    "persistence disabled".

    ── THE PORT IS 5434, AND THE REASON IS A REAL FAILURE ──────────────────
    `docker-compose.yml` publishes 5434, not 5432 — developer machines very
    often already run a Postgres on the default port, and connecting to the
    wrong server produces a confusing "database exists but the tables are
    missing".

    It was 5433 until Sep 9, when that collided with another project's
    container already healthy on this machine. `store.connect()` reached a
    real Postgres and was refused with `password authentication failed for
    user "echo"`, so /health reported persistence disabled and the Ledger
    silently ran in memory — losing the incident on every restart. The
    credentials looked wrong; the port was wrong.

    Keep this in step with `docker-compose.yml`.
    """
    return _optional(
        "DATABASE_URL", "postgresql://echo:echo@127.0.0.1:5434/echosphere"
    )


def persistence_enabled() -> bool:
    """
    Whether to persist the Ledger at all.

    Explicit opt-out via `LEDGER_PERSISTENCE=off`, because a developer running
    the Rehearsal Rig against a scratch incident should be able to keep the
    database out of the picture without stopping the container.
    """
    return _optional("LEDGER_PERSISTENCE", "on").lower() not in ("off", "0", "false")


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
