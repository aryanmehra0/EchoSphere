"""
Gemma — the analysis LLM over the OpenAI chat-completions format.

────────────────────────────────────────────────────────────────────────────
WHAT THIS TALKS TO

Any OpenAI-compatible server hosting Gemma: Ollama, vLLM, LM Studio,
llama.cpp's server, or a hosted gateway. The endpoint is configuration, not
code — `GEMMA_BASE_URL` points at whatever is serving it:

    GEMMA_BASE_URL=http://127.0.0.1:8443/v1
    GEMMA_MODEL=gemma-3-27b-it
    ANALYSIS_PROVIDER=gemma,groq

Note that Groq does NOT serve Gemma any more — its catalog was checked live
and carries none, so this provider exists precisely because the model has to
come from elsewhere.

────────────────────────────────────────────────────────────────────────────
WHY RAW httpx AND NOT THE OPENAI SDK

The OpenAI package is not a dependency of this service and adding one for a
single POST would be the wrong trade: `httpx` is already here (the Bridge
speaks to Agora through it), the request is one JSON body, and the response
field we need is `choices[0].message.content`. That is the whole surface.

It also keeps the adapter honest about what it supports. An SDK would imply
the full OpenAI feature set works against every server this can point at; in
practice a local Ollama or vLLM implements a subset, and the subset used here
is deliberately the smallest one that does the job.

────────────────────────────────────────────────────────────────────────────
WHY A SECOND PROVIDER AT ALL

Groq's daily cap is per key AND per model, and every entry in the fallback
chain draws from the same account — so a hard day of rehearsals exhausts all
of them together. When that happens nothing announces it: the console joins,
transcripts flow, Echo sits in the channel, and no claims appear because
every extraction is dying on a 429 nobody is reading. A locally hosted model
has no quota at all, which makes it the useful thing to fall back to.

It is OPT-IN. With no Gemma base URL or key set, `analysis_providers()`
returns Groq alone and behaviour is bit-for-bit what it was.

────────────────────────────────────────────────────────────────────────────
MEASURED QUALITY, SO NOBODY HAS TO GUESS

Against Rig Tier 3's four-line fixture, on the same machine, same run:

    Groq  openai/gpt-oss-120b   12/12
    Gemma gemma-4-26B-A4B-it    11/12

The one Gemma misses is "a gap was noticed" — `unchecked[]`, requirement 5's
quiet half. It is NOT a parsing fault: fed a single-line window the same
model emits two unchecked items correctly, so the plumbing works and the
model is simply less eager to volunteer them once a window carries more
context.

Everything the product actually claims holds on both: the hedge stays out of
the facts, every claim keeps its speaker, entities converge, and the
Deliberation Panel adjudicated the headline pair OPPOSED at 0.90.

So: Gemma is a sound fallback for keeping a bridge alive when the Groq budget
is gone, and Groq remains the better primary. Prefer `groq,gemma` unless the
budget is the binding constraint.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .. import config

log = logging.getLogger("echo.gemma")

# Matches the Groq adapter's ceiling and exists for the same measured reason:
# reasoning-capable models emit tokens before the JSON, and a tight cap
# truncates them mid-thought so the object never closes. See
# `panel.PANEL_MAX_TOKENS`.
DEFAULT_MAX_TOKENS = 4096

# Long enough for a reasoning pass on a slow local box, short enough that a
# hung server does not park the pipeline forever. The Slow Loop's own budget
# is 4s (§12.2), but extraction runs in a background task, so this ceiling
# protects against a dead socket rather than enforcing latency.
REQUEST_TIMEOUT = 90.0


class GemmaError(RuntimeError):
    """A Gemma call that cannot be retried into success."""


def _is_rate_limited(status: int, body: str) -> bool:
    low = body.lower()
    return status == 429 or "rate limit" in low or "rate_limit" in low


def _is_quota_exhausted(body: str) -> bool:
    """
    A hard stop rather than a wait.

    Hosted gateways report an empty balance in the body rather than with a
    distinct status, and the distinction matters for the same reason it does
    on Groq: a per-minute limit clears while you are setting up, an exhausted
    account does not clear today. Retrying the second is pure latency.

    A local server will never hit this branch, which is the point of running
    one.
    """
    low = body.lower()
    return any(
        marker in low
        for marker in ("insufficient", "quota", "exceeded your current", "billing")
    )


async def chat_json(
    system: str,
    user: str,
    *,
    model: str,
    api_key: str = "",
    max_tokens: int = DEFAULT_MAX_TOKENS,
    client: httpx.AsyncClient | None = None,
) -> str:
    """
    One chat completion, forced to JSON. Returns the raw message content.

    Raises `GemmaError` on anything the caller cannot fix by waiting — an
    unreachable server, a bad model name, a rejected key — so the provider
    chain above can move on rather than burning its retry budget.
    """
    url = f"{config.gemma_base_url()}/chat/completions"

    headers = {"Content-Type": "application/json"}
    # A local server commonly authenticates nothing. Sending
    # `Authorization: Bearer ` with an empty value makes some of them 401 a
    # request they would otherwise have served, so the header is omitted
    # entirely when there is no key.
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        # 0.2 — matched to the Groq adapter deliberately. The value was chosen
        # by measurement there (0.0 tested WORSE for contradiction detection),
        # and running the two providers at different temperatures would make
        # any Tier 2 comparison between them meaningless.
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
    try:
        response = await http.post(url, headers=headers, json=payload)
    except httpx.RequestError as exc:
        # Connection refused, DNS, TLS. Named explicitly because the most
        # likely cause is a local server that is not running, and
        # "all analysis providers failed" would send someone hunting for a
        # quota problem they do not have.
        raise GemmaError(f"Gemma endpoint unreachable at {url}: {exc}") from exc
    finally:
        if owns_client:
            await http.aclose()

    if not response.is_success:
        body = response.text[:400]
        if _is_quota_exhausted(body):
            raise GemmaError(
                f"Gemma quota or balance exhausted ({response.status_code}): {body}"
            )
        if _is_rate_limited(response.status_code, body):
            raise GemmaError(f"Gemma rate limited (429): {body}")
        raise GemmaError(f"Gemma returned {response.status_code}: {body}")

    try:
        data = response.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise GemmaError(
            f"Gemma response was not an OpenAI chat completion: {response.text[:300]}"
        ) from exc

    # An empty completion is not a crash, and the callers already tolerate it:
    # `extraction._parse` and the panel both treat "{}" as "the model returned
    # nothing usable" and take their repair path.
    return content or "{}"


async def probe(*, model: str | None = None) -> dict[str, Any]:
    """
    Can Gemma serve an extraction right now?

    Shaped to match one row of `/health/model`'s output so the pre-flight can
    report both providers in the same table.
    """
    target = model or config.gemma_models()[0]
    keys = config.gemma_api_keys()
    try:
        await chat_json(
            'Reply with the JSON object {"ok":true} and nothing else.',
            "Return that json now.",
            model=target,
            api_key=keys[0] if keys else "",
            # Matches the Groq probe: a reasoning pass needs room before the
            # JSON, or it truncates and reports as unavailable.
            max_tokens=1536,
        )
        return {"model": target, "provider": "gemma", "available": True}
    except Exception as exc:  # noqa: BLE001 — report, never raise, from a probe
        message = str(exc)
        log.warning("gemma probe: %s unavailable — %s", target, message)
        return {
            "model": target,
            "provider": "gemma",
            "available": False,
            "reason": (
                "endpoint unreachable — is the server running?"
                if "unreachable" in message
                else "quota or balance exhausted" if "exhausted" in message
                else "rate limited" if "rate limited" in message
                else "request rejected — see detail"
            ),
            "detail": message[-300:],
        }
