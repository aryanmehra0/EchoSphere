"""
Is there any analysis budget left today?

────────────────────────────────────────────────────────────────────────────
WHY THIS IS CHECKED AT ALL

Groq's free tier is 200,000 tokens per DAY, scoped per model. A full demo
costs 15–20k, so roughly ten runs — and a day of tuning eats all of it.
When it goes, nothing announces it. The console still joins, the dashboard
still fills with transcripts, Echo still sits in the channel. The claims
simply never appear, because every extraction is failing behind the scenes
with a 429 nobody is looking at.

That is the worst possible failure to discover with an audience watching, and
it is invisible right up until the moment it matters. So the pre-flight asks,
using a deliberately tiny probe, and refuses to say GO when the answer is no.

────────────────────────────────────────────────────────────────────────────
WHY IT IS A MODULE AND NOT A ROUTE BODY

Classifying a vendor's error strings is guesswork that changes when the vendor
changes, and the distinction it draws is operationally load-bearing: a
per-MINUTE limit clears while you are still setting up, a per-DAY one means
there is no demo today. That deserves its own tests, which a function inside a
route handler cannot easily have.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .. import config

log = logging.getLogger("echo.budget")

# ── WHY 1536 AND NOT 64 ─────────────────────────────────────────────────────
# 64 looks obviously generous for `{"ok":true}` and is wrong. These are
# REASONING models: they emit reasoning tokens before the JSON, so a tight
# ceiling truncates them mid-thought and Groq returns
#
#     400 json_validate_failed, failed_generation: ''
#
# which this then reported as the model being unavailable. The pre-flight spent
# a day insisting two healthy models were exhausted, and a check that cries
# wolf is worse than no check — it trains you to ignore the one time it is
# right. Matches `panel.PANEL_MAX_TOKENS` for the same reason.
PROBE_MAX_TOKENS = 1536

# The word "json" must appear literally in the messages — Groq rejects
# `response_format: json_object` without it, with a 400. The first version of
# this probe said 'Reply with {"ok":true}' and failed every single time.
_PROBE_SYSTEM = 'Reply with the JSON object {"ok":true} and nothing else.'
_PROBE_USER = "Return that json now."


def classify(message: str) -> str:
    """
    Turn a vendor error string into an answer an operator can act on.

    The per-day / per-minute split is the whole point: telling someone "rate
    limited" for both is useless at exactly the moment they need to decide
    whether to wait ninety seconds or reschedule the demo.
    """
    low = message.lower()
    if "per day" in low or "tpd" in low:
        return "DAILY quota exhausted — resets tomorrow"
    if "per minute" in low or "tpm" in low:
        return "per-minute limit — clears in under a minute"
    if "429" in message or "rate_limit" in low:
        return "rate limited"
    # NOT a quota problem. Saying "rate limited" here sent an operator hunting
    # for a budget they had not spent.
    return "request rejected — see detail"


def _failure_row(model: str, exc: Exception) -> dict[str, Any]:
    message = str(exc)

    wait = re.search(r"try again in ([\dhms.]+)", message)
    used = re.search(r"Used (\d+)", message)
    limit = re.search(r"Limit (\d+)", message)

    # The raw text, truncated, is the ground truth. Classifying vendor error
    # strings is guesswork — Groq has at least TPM, TPD and RPM shapes and they
    # change — so the parsed fields are a convenience and `detail` is what an
    # operator should trust.
    log.warning("model probe: %s unavailable — %s", model, message)

    return {
        "model": model,
        "available": False,
        "reason": classify(message),
        "retryAfter": wait.group(1) if wait else None,
        "used": int(used.group(1)) if used else None,
        "limit": int(limit.group(1)) if limit else None,
        "detail": message[-300:],
    }


async def probe(*, probe_all: bool = False) -> dict[str, Any]:
    """
    Ask the model chain whether it can still serve an extraction.

    ── PRIMARY ONLY, UNLESS ASKED FOR EVERYTHING ───────────────────────────
    Probing all three models serially means three calls, each with its own
    rate-limit retries — which under load takes minutes and timed the
    pre-flight out, reporting "could not probe the model — is the Slow Loop
    up?" while the Slow Loop was plainly up and answering.

    The question a pre-flight actually asks is "can we run a demo now", and
    the primary model answers it: the fallbacks only matter once it is gone,
    and `groq_json` reaches them on its own. `probe_all` gets the fuller
    picture when it is genuinely wanted.
    """
    from ..adapters import gemma
    from ..extraction import groq_json

    providers = config.analysis_providers()
    if not providers:
        return {
            "usable": 0,
            "primary": None,
            "keys": 0,
            "providers": [],
            "models": [{
                "model": None,
                "available": False,
                "reason": "no analysis provider configured",
                "detail": "set GROQ_API_KEY, or GEMMA_BASE_URL "
                          "with ANALYSIS_PROVIDER=gemma",
            }],
        }

    results: list[dict[str, Any]] = []
    for provider, chain, keys in providers:
        models_to_probe = chain if probe_all else chain[:1]

        for model in models_to_probe:
            if provider == "gemma":
                # The Gemma adapter classifies its own failures — an
                # unreachable local server is a different problem from an
                # exhausted balance, and its error strings differ from Groq's.
                results.append(await gemma.probe(model=model))
                continue
            try:
                # `groq_json` rotates keys internally, so "available" means
                # "reachable on at least one key" — the question a pre-flight
                # actually needs answered.
                await groq_json(
                    _PROBE_SYSTEM, _PROBE_USER,
                    max_tokens=PROBE_MAX_TOKENS,
                    models=[model],
                )
                results.append({"model": model, "provider": "groq", "available": True})
            except Exception as exc:  # noqa: BLE001 — the SDK raises several shapes
                results.append({**_failure_row(model, exc), "provider": "groq"})

        # Only the first provider is probed unless the caller asked for all —
        # the question is "can we run now", and the fallback provider only
        # matters once the first is gone.
        if not probe_all:
            break

    usable = [r for r in results if r["available"]]
    return {
        "usable": len(usable),
        "primary": results[0]["model"] if results else None,
        # Surfaced so the pre-flight can say "budget is tight" honestly: with
        # two keys a single exhausted model is far less alarming than with one.
        "keys": sum(len(keys) for _, _, keys in providers),
        # Which providers are configured, in try order. Named so an operator
        # can see at a glance whether Gemma is actually wired up or silently
        # absent because its base URL was never set.
        "providers": [p for p, _, _ in providers],
        "models": results,
    }
