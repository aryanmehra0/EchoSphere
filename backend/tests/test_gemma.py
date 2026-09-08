"""
Gemma as a second analysis provider.

Two things are asserted here, and the second is the one that matters:

  1. Provider RESOLUTION — which provider serves a call, given the env. This
     is pure config logic and cheap to get subtly wrong in a way that only
     shows up when a quota runs out, which is the worst possible time.

  2. That adding Gemma changed NOTHING for a Groq-only machine. The whole
     point of the seam is that the default path is bit-for-bit what it was,
     and a test is the only way to keep that true.

No network. The adapter is driven through `httpx.MockTransport`, because
asserting against a live endpoint would make this suite depend on a server
being up.

Run:  .venv/Scripts/python -m unittest discover -s tests -t .
"""

from __future__ import annotations

import asyncio
import json
import os
import unittest
from unittest import mock

import httpx

# Module level — see the note in test_conversation.py about `load_dotenv` and
# `mock.patch.dict` deleting every credential on exit.
from app import config
from app.adapters import gemma

LOCAL = "http://127.0.0.1:8443/v1"


def run(coro):
    return asyncio.run(coro)


def env(**overrides: str):
    """
    Patch the analysis env, clearing everything this module reads.

    Explicit empty strings rather than `clear=True`: the latter would drop the
    Agora credentials `config` loaded from `.env.local` at import, and
    `/health` in a later test would then report 503 for reasons unrelated to
    that test.
    """
    base = {
        "GROQ_API_KEY": "",
        "GROQ_API_KEY_2": "",
        "GROQ_API_KEY_3": "",
        "GEMMA_API_KEY": "",
        "GEMMA_API_KEY_2": "",
        "GEMMA_API_KEY_3": "",
        "GEMMA_BASE_URL": "",
        "GEMMA_MODEL": "",
        "GEMMA_MODEL_FALLBACKS": "",
        "ANALYSIS_PROVIDER": "",
    }
    return mock.patch.dict(os.environ, {**base, **overrides})


async def _call(handler, **kwargs) -> str:
    """One adapter call against a fake transport."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await gemma.chat_json(
            kwargs.pop("system", "sys"),
            kwargs.pop("user", "usr"),
            client=client,
            **kwargs,
        )


class ProviderResolution(unittest.TestCase):
    """`analysis_providers()` decides who serves every analytical call."""

    def test_groq_only_is_the_default(self) -> None:
        with env(GROQ_API_KEY="gsk_test"):
            providers = config.analysis_providers()
        self.assertEqual([p for p, _, _ in providers], ["groq"])

    def test_gemma_is_absent_until_configured(self) -> None:
        """
        The default must not change for anyone who has not opted in. This is
        the regression guard for the entire feature.
        """
        with env(GROQ_API_KEY="gsk_test"):
            self.assertNotIn("gemma", [p for p, _, _ in config.analysis_providers()])

    def test_gemma_only_is_a_valid_configuration(self) -> None:
        with env(GEMMA_BASE_URL=LOCAL, ANALYSIS_PROVIDER="gemma"):
            providers = config.analysis_providers()
        self.assertEqual([p for p, _, _ in providers], ["gemma"])
        # And it must carry Gemma model names, not Groq's.
        self.assertTrue(all(m.startswith("gemma") for m in providers[0][1]))

    def test_both_providers_in_the_requested_order(self) -> None:
        for order in ("gemma,groq", "groq,gemma"):
            with self.subTest(order=order):
                with env(GROQ_API_KEY="gsk_test", GEMMA_BASE_URL=LOCAL,
                         ANALYSIS_PROVIDER=order):
                    resolved = [p for p, _, _ in config.analysis_providers()]
                self.assertEqual(resolved, order.split(","))

    def test_a_preference_for_an_unconfigured_provider_is_ignored(self) -> None:
        """
        Asking for Gemma first on a machine with no Gemma endpoint must RUN,
        not fail. Preferring something unavailable is a configuration mistake
        the service should survive, not die on.
        """
        with env(GROQ_API_KEY="gsk_test", ANALYSIS_PROVIDER="gemma,groq"):
            providers = config.analysis_providers()
        self.assertEqual([p for p, _, _ in providers], ["groq"])

    def test_a_typo_in_the_provider_list_does_not_crash(self) -> None:
        with env(GROQ_API_KEY="gsk_test", ANALYSIS_PROVIDER="gemmaa,gpt4"):
            # Unknown names dropped; falls back to the default rather than
            # raising on an env var typo.
            self.assertEqual([p for p, _, _ in config.analysis_providers()], ["groq"])

    def test_a_local_server_needs_no_key(self) -> None:
        """
        Ollama / vLLM / LM Studio on 127.0.0.1 usually authenticate nothing,
        so a base URL alone must enable the provider. Requiring a key would
        make a working endpoint look unconfigured.
        """
        with env(GEMMA_BASE_URL=LOCAL, ANALYSIS_PROVIDER="gemma"):
            self.assertTrue(config.gemma_enabled())
            self.assertEqual(config.gemma_api_keys(), [])
            providers = config.analysis_providers()
        self.assertEqual([p for p, _, _ in providers], ["gemma"])
        # One empty-string key, so the rotation loop's shape is unchanged.
        self.assertEqual(providers[0][2], [""])

    def test_a_key_without_an_endpoint_is_not_enough(self) -> None:
        """
        There is no default host to fall back on — guessing one would turn
        "you forgot the URL" into a confusing connection error against
        somebody else's server.
        """
        with env(GEMMA_API_KEY="k", ANALYSIS_PROVIDER="gemma"):
            self.assertFalse(config.gemma_enabled())
            self.assertEqual(config.analysis_providers(), [])

    def test_no_provider_at_all_is_reported_not_raised(self) -> None:
        with env():
            self.assertEqual(config.analysis_providers(), [])
            # The old `groq_api_keys()` raised here, which would have refused
            # to start a Gemma-only bridge.
            self.assertEqual(config.groq_api_keys(), [])

    def test_the_base_url_trailing_slash_is_trimmed(self) -> None:
        """A double slash in the joined path 404s on some servers."""
        with env(GEMMA_BASE_URL="http://127.0.0.1:8443/v1/"):
            self.assertEqual(config.gemma_base_url(), LOCAL)

    def test_the_default_model_is_the_served_id(self) -> None:
        """
        `gemma4` looks like a typo and is correct — it is what the vLLM server
        this was built against actually advertises at GET /v1/models. The
        model's real name is Gemma-4-26B-A4B-it, exposed as `root`, and
        sending THAT gets a 404 from an otherwise healthy server.

        Pinned in a test because "fixing" this to a plausible-looking
        HuggingFace id would break every call with an error that reads like
        the server is down.
        """
        with env(GEMMA_BASE_URL=LOCAL):
            self.assertEqual(config.gemma_models(), ["gemma4"])

    def test_no_phantom_fallback_model_by_default(self) -> None:
        """
        A local server usually hosts exactly one model. A default second name
        would be a guaranteed 404 on the way to giving up — a wasted round
        trip and an alarming log line for a configuration that is fine.
        """
        with env(GEMMA_BASE_URL=LOCAL):
            self.assertEqual(len(config.gemma_models()), 1)
        # ...but an explicit chain is still honoured.
        with env(GEMMA_BASE_URL=LOCAL, GEMMA_MODEL="a", GEMMA_MODEL_FALLBACKS="b,c"):
            self.assertEqual(config.gemma_models(), ["a", "b", "c"])


class GemmaAdapter(unittest.TestCase):
    """The OpenAI-shaped call, driven through a fake transport."""

    def test_it_sends_an_openai_chat_completion_and_reads_the_content(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={
                "choices": [{"message": {"content": '{"ok":true}'}}],
            })

        with env(GEMMA_BASE_URL=LOCAL, GEMMA_API_KEY="k1"):
            out = run(_call(handler, model="gemma-3-27b-it", api_key="k1"))

        self.assertEqual(out, '{"ok":true}')
        self.assertEqual(seen["url"], f"{LOCAL}/chat/completions")
        self.assertEqual(seen["auth"], "Bearer k1")

        body = seen["body"]
        self.assertEqual(body["model"], "gemma-3-27b-it")
        # JSON mode is what makes the extraction contract enforceable.
        self.assertEqual(body["response_format"], {"type": "json_object"})
        # Matched to the Groq adapter on purpose: differing temperatures would
        # make any Tier 2 comparison between providers meaningless.
        self.assertEqual(body["temperature"], 0.2)
        self.assertEqual(
            body["messages"],
            [{"role": "system", "content": "sys"},
             {"role": "user", "content": "usr"}],
        )

    def test_no_auth_header_when_there_is_no_key(self) -> None:
        """
        Sending `Authorization: Bearer ` with an empty value makes some local
        servers 401 a request they would otherwise have served.
        """
        seen: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["auth"] = request.headers.get("authorization")
            return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

        with env(GEMMA_BASE_URL=LOCAL):
            run(_call(handler, model="gemma-3-27b-it", api_key=""))

        self.assertIsNone(seen["auth"])

    def test_an_unreachable_endpoint_says_so(self) -> None:
        """
        The most likely failure for a local server is that it is not running.
        Reporting that as a quota problem would send someone hunting for a
        budget they never spent.
        """
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        with env(GEMMA_BASE_URL=LOCAL):
            with self.assertRaises(gemma.GemmaError) as caught:
                run(_call(handler, model="gemma-3-27b-it"))

        self.assertIn("unreachable", str(caught.exception))

    def test_an_exhausted_balance_is_distinguished_from_a_rate_limit(self) -> None:
        """
        Same distinction the Groq adapter draws, and for the same operational
        reason: a rate limit clears while you are setting up, an empty account
        does not clear today.
        """
        def broke(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={
                "error": {"message": "Insufficient balance"},
            })

        with env(GEMMA_BASE_URL=LOCAL):
            with self.assertRaises(gemma.GemmaError) as caught:
                run(_call(broke, model="gemma-3-27b-it"))

        self.assertIn("exhausted", str(caught.exception).lower())

    def test_a_plain_rate_limit_is_reported_as_one(self) -> None:
        def limited(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={"error": {"message": "rate limit reached"}})

        with env(GEMMA_BASE_URL=LOCAL):
            with self.assertRaises(gemma.GemmaError) as caught:
                run(_call(limited, model="gemma-3-27b-it"))

        self.assertIn("rate limited", str(caught.exception).lower())

    def test_a_non_openai_response_shape_is_named_clearly(self) -> None:
        def wrong(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"result": "not openai shaped"})

        with env(GEMMA_BASE_URL=LOCAL):
            with self.assertRaises(gemma.GemmaError) as caught:
                run(_call(wrong, model="gemma-3-27b-it"))

        self.assertIn("not an OpenAI chat completion", str(caught.exception))

    def test_an_empty_completion_becomes_empty_json(self) -> None:
        """
        `extraction._parse` and the panel both already treat "{}" as "nothing
        usable, take the repair path". Returning None here would crash them.
        """
        def empty(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {"content": ""}}]})

        with env(GEMMA_BASE_URL=LOCAL):
            out = run(_call(empty, model="gemma-3-27b-it"))

        self.assertEqual(out, "{}")


class PanelFollowsTheProvider(unittest.TestCase):

    def test_personas_get_gemma_models_on_a_gemma_only_box(self) -> None:
        """
        The panel pins one model per persona for independence. On a Gemma-only
        configuration those pins must be `gemma-*`, or every persona 404s and
        the panel abstains into silence — which reads as "no contradiction
        found" rather than as a failure.
        """
        from app.panel import personas

        with env(GEMMA_BASE_URL=LOCAL, ANALYSIS_PROVIDER="gemma",
                 GEMMA_MODEL="gemma-3-27b-it",
                 GEMMA_MODEL_FALLBACKS="gemma-3-12b-it"):
            bench, referee = personas()

        for persona in [*bench, referee]:
            with self.subTest(persona=persona.name):
                self.assertTrue(
                    persona.model.startswith("gemma"),
                    f"{persona.name} pinned {persona.model!r} on a Gemma-only box",
                )

    def test_personas_still_get_groq_models_by_default(self) -> None:
        """The regression guard for the default path."""
        from app.panel import personas

        with env(GROQ_API_KEY="gsk_test"):
            bench, referee = personas()

        for persona in [*bench, referee]:
            with self.subTest(persona=persona.name):
                self.assertFalse(persona.model.startswith("gemma"))


class ReadinessDoesNotRequireGroq(unittest.TestCase):

    def test_a_gemma_only_bridge_reports_an_analysis_llm(self) -> None:
        with env(GEMMA_BASE_URL=LOCAL, ANALYSIS_PROVIDER="gemma"):
            creds = config.credential_status()
        self.assertTrue(creds["ANALYSIS_LLM"])
        # And is honest that Groq specifically is not configured.
        self.assertFalse(creds["GROQ_API_KEY"])

    def test_no_provider_means_no_analysis_llm(self) -> None:
        with env():
            self.assertFalse(config.credential_status()["ANALYSIS_LLM"])


if __name__ == "__main__":
    unittest.main()
