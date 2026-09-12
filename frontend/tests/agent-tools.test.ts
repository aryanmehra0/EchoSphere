import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentPayload,
  buildLlmVendor,
  MANAGED_FAST_LOOP_MODEL,
  MANAGED_OPENAI_URL,
  inferAsrPreset,
  inferLlmPreset,
  resolveSessionPresets,
  MANAGED_MODELS,
  buildPreset,
  buildSystemPrompt,
  buildToolsBlock,
  FAST_LOOP_MODEL,
  FAST_LOOP_SYSTEM_PROMPT,
  NO_TOOLS_ADDENDUM,
  SECRETS_CLAUSE,
  AGENT_TOOLS,
} from "../src/lib/server/agent-config.ts";

/**
 * Whether a human can hold a conversation with Echo.
 *
 * ── THE DEFECT THESE PIN ────────────────────────────────────────────────────
 * Agora's Engine calls REST tools from ITS OWN servers, so with no public URL
 * the agent is created with no tools at all. Echo was then under Rule 3 —
 * "NEVER ANSWER FROM MEMORY, call query_incident_state" — while holding no
 * such instrument. A model in that bind either goes silent, which reads as
 * broken, or decides the rule cannot have meant this and answers from memory,
 * which is the confident unsourced answer this product exists to prevent.
 *
 * Both halves are asserted here: that the prompt names the situation when the
 * Ledger is unreachable, and that when it IS reachable every tool call carries
 * the token the backend's tunnel gate demands.
 */

describe("the system prompt adapts to whether the Ledger is readable", () => {
  test("with tools, the prompt is the reviewed constant plus ONLY the secrets clause", () => {
    /*
      This asserted exact equality, to stop the epistemic rules acquiring an
      invisible tail. The intent is right and is kept — but one deliberate
      tail now exists, and it was added for a reported leak:

      A password spoken aloud was scrubbed from the transcript, the Ledger and
      Postgres, and Echo STILL said it back, because Agora keeps `max_history`
      turns of raw ASR in its own LLM context. Our redaction cannot reach that
      copy; only the prompt can.

      So the assertion becomes "the constant, plus the secrets clause, and
      nothing else" — which still catches an accidental tail while permitting
      the one that was reviewed.
    */
    assert.equal(
      buildSystemPrompt(true, "incident"),
      FAST_LOOP_SYSTEM_PROMPT + SECRETS_CLAUSE,
    );
  });

  test("without tools, it says so rather than leaving the model stuck", () => {
    const prompt = buildSystemPrompt(false, "incident");
    assert.ok(prompt.startsWith(FAST_LOOP_SYSTEM_PROMPT));
    assert.ok(prompt.includes(NO_TOOLS_ADDENDUM.trim().split("\n")[0]));
  });

  test("the addendum does not relax Rule 3, it reports it cannot be met", () => {
    const prompt = buildSystemPrompt(false, "incident");
    // \s+ not a literal space: the addendum hard-wraps, and a test that
    // breaks on rewrapping is a test nobody keeps.
    assert.ok(/does\s+NOT\s+relax\s+Rule\s+3/i.test(prompt));
    // The failure mode being prevented: reconstructing the incident from
    // whatever was overheard, which is exactly an unsourced answer.
    assert.ok(/do not reconstruct/i.test(prompt));
  });

  test("Rule 3 survives in both forms", () => {
    for (const enabled of [true, false]) {
      assert.ok(
        /NEVER ANSWER FROM MEMORY/.test(buildSystemPrompt(enabled, "incident")),
        `Rule 3 missing with tools ${enabled}`,
      );
    }
  });
});

describe("tool calls authenticate themselves", () => {
  test("no public URL means no tools at all, not broken tools", () => {
    assert.deepEqual(buildToolsBlock(null), {});
    assert.deepEqual(buildToolsBlock(null, "a-secret"), {});
  });

  test("every tool carries the tunnel-gate token", () => {
    const block = buildToolsBlock("https://x.trycloudflare.com", "a-secret") as {
      tools: Array<{ server: { headers: Record<string, string>; url: string } }>;
    };

    assert.ok(block.tools.length > 0, "expected at least one tool");
    for (const tool of block.tools) {
      assert.equal(
        tool.server.headers["X-Echo-Tool-Token"],
        "a-secret",
        `${tool.server.url} would come back 401 from the tunnel gate`,
      );
    }
  });

  test("without a secret the header is absent rather than empty", () => {
    // An empty token would be sent, fail `compare_digest`, and produce a 401
    // that looks exactly like Echo refusing to answer. Absent is honest: the
    // gate only applies to remote hosts, and a local base URL needs no token.
    const block = buildToolsBlock("http://127.0.0.1:8000") as {
      tools: Array<{ server: { headers: Record<string, string> } }>;
    };
    for (const tool of block.tools) {
      assert.equal("X-Echo-Tool-Token" in tool.server.headers, false);
    }
  });

  test("tools are declared in the shape Agora accepts", () => {
    const block = buildToolsBlock("https://x.trycloudflare.com", "s") as {
      tools: Array<{
        type: string;
        function: { name: string };
        server: { method: string; url: string };
      }>;
    };

    for (const tool of block.tools) {
      // `type` and `server` together are what declare a REST tool; omitting
      // either is a 400 at create time, and getting a 400 at create time is
      // how the agent ends up with no tools without anyone noticing.
      assert.equal(tool.type, "function");
      assert.equal(tool.server.method, "POST");
      assert.ok(tool.server.url.startsWith("https://x.trycloudflare.com/"));
      assert.ok(tool.function.name.length > 0);
    }
  });

  test("query_incident_state is present — it is the one that matters", () => {
    const block = buildToolsBlock("https://x.trycloudflare.com", "s") as {
      tools: Array<{ function: { name: string } }>;
    };
    const names = block.tools.map((t) => t.function.name);
    assert.ok(names.includes("query_incident_state"));
  });
});

describe("Echo does not fill silence", () => {
  const payload = (over: Record<string, unknown> = {}) =>
    buildAgentPayload({
      channel: "inc-4417",
      agentUid: 9000,
      userUid: 1001,
      agentRtcToken: "token",
      groqApiKey: "key",
      tts: { vendor: "elevenlabs", apiKey: "tts-key" },
      ...over,
    }) as {
      properties: { llm: { greeting_message: string; failure_message: string; params: { model: string } } };
    };

  test("failure_message is empty, so a silent turn stays silent", () => {
    /*
      This was "One moment.", and a live run recorded Echo saying it five
      times into an otherwise empty channel. Agora's recogniser emits turns
      for non-speech; the model, obeying "default is ABSOLUTE SILENCE",
      returns nothing; Agora reads an empty completion as a failure and
      speaks this field. The better the prompt is obeyed, the more filler
      Echo produces.
    */
    assert.equal(payload().properties.llm.failure_message, "");
  });

  test("greeting_message is empty — the Slow Loop composes the arrival line", () => {
    // Not an oversight. This field makes the MODEL write the greeting, and
    // §6 does not trust the model to speak unsupervised. `utterance.joined`
    // composes it and it goes out through /speak, validated like every other
    // sentence Echo says.
    assert.equal(payload().properties.llm.greeting_message, "");
  });

  test("the model can be chosen per invite, and defaults to the primary", () => {
    // Groq's daily budget is per key AND per model, and Agora's payload
    // carries exactly one of each with no way to rotate. `selectFastLoopModel`
    // picks a pair that answered; without this the agent was handed the
    // exhausted primary and went mute.
    assert.equal(payload().properties.llm.params.model, FAST_LOOP_MODEL);
    assert.equal(
      payload({ groqModel: "openai/gpt-oss-20b" }).properties.llm.params.model,
      "openai/gpt-oss-20b",
    );
  });
});

describe("the managed Fast Loop matches the official quickstart", () => {
  /*
    Read off `agora_agent/agentkit/vendors/llm.py`, `OpenAI.to_config()`:

      config = { url: base_url or "https://api.openai.com/v1/chat/completions",
                 params, style: "openai", input_modalities }
      if api_key is not None: config["api_key"] = api_key

    and its validator:

      "OpenAI Agora-managed mode does not allow vendor"
      "OpenAI requires api_key unless using a supported Agora-managed model"

    The first attempt at managed mode sent `vendor: "openai"` with no url -
    precisely the combination the SDK forbids. Agora answered 200 RUNNING and
    the LLM leg never ran, which is this API's signature failure.
  */
  test("managed sends no url, no api_key and no model - the preset carries them", () => {
    /*
      `to_config()` emits the OpenAI url, but the session layer then runs
      `strip_inferred_preset_fields()`, which removes `url`, `api_key` and
      `params.model` once `openai_gpt_4o_mini` has been inferred from them.
      Only what the preset does NOT cover reaches the wire.

      Sending a key anyway is not harmless: `infer_llm_preset` returns null
      for any llm block carrying `api_key`, which silently drops the agent
      off the managed path.
    */
    /*
      ASSERTED ON THE FINAL PAYLOAD, NOT ON `buildLlmVendor`.

      Those are two different stages and only the second is the wire. The
      builder now emits a FULL block — url and params.model present — because
      `inferLlmPreset` derives `openai_gpt_4o_mini` FROM those fields, and
      `resolveSessionPresets` strips them immediately afterwards.

      This test used to assert the stripped shape at the builder, which forced
      the builder to pre-strip; nothing could then be inferred, and the
      hardcoded preset was asserted against a block that never justified it.
      That is the joined-but-deaf agent. Assert the outcome, not the midpoint.
    */
    const llm = buildLlmVendor("managed", "unused-key", "unused-model");
    assert.equal("api_key" in llm, false, "a key drops us off the managed path");
    assert.equal(llm.style, "openai");
    assert.equal(llm.url, MANAGED_OPENAI_URL, "inference needs the url");
    assert.equal(llm.params.model, MANAGED_FAST_LOOP_MODEL, "inference needs the model");

    const payload = buildAgentPayload({
      channel: "c",
      agentUid: 9000,
      userUid: 1001,
      agentRtcToken: "t",
      groqApiKey: "unused",
      llmMode: "managed",
      tts: { vendor: "elevenlabs", apiKey: "k", voiceId: "v" },
    }) as unknown as {
      preset: string;
      properties: { llm: Record<string, unknown> & { params: { model?: string } } };
    };
    const wire = payload.properties.llm;
    assert.equal(payload.preset, "deepgram_nova_3,openai_gpt_4o_mini");
    assert.equal("url" in wire, false, "the preset carries the url");
    assert.equal("api_key" in wire, false, "a key drops us off the managed path");
    assert.equal(wire.params.model, undefined, "the preset carries the model");
  });

  test("the preset names every managed category, comma-joined", () => {
    // `resolve_session_presets` composes one entry per managed category.
    // ASR is always managed; the LLM entry appears only in managed mode.
    assert.equal(buildPreset("managed"), "deepgram_nova_3,openai_gpt_4o_mini");
    assert.equal(buildPreset("groq"), "deepgram_nova_3");
  });

  test("managed never sends `vendor` - the SDK rejects that outright", () => {
    const llm = buildLlmVendor("managed", "k", "m");
    assert.equal("vendor" in llm, false);
  });

  test("the managed model is one Agora will supply a credential for", () => {
    assert.ok(
      MANAGED_MODELS.includes(MANAGED_FAST_LOOP_MODEL),
      `${MANAGED_FAST_LOOP_MODEL} is not on the SDK allowlist; a key would be required`,
    );
  });

  test("groq mode still carries url, key and style", () => {
    const llm = buildLlmVendor("groq", "gsk-test", "openai/gpt-oss-120b");
    assert.match(String(llm.url), /api\.groq\.com/);
    assert.equal(llm.api_key, "gsk-test");
    assert.equal(llm.style, "openai");
    assert.equal(llm.params.model, "openai/gpt-oss-120b");
  });

  test("both modes keep the epistemic prompt and the tools", () => {
    for (const mode of ["managed", "groq"] as const) {
      const p = buildAgentPayload({
        channel: "inc-4417", agentUid: 9000, userUid: 1001,
        agentRtcToken: "t", groqApiKey: "k",
        tts: { vendor: "elevenlabs", apiKey: "e" },
        toolBaseUrl: "https://x.trycloudflare.com", toolSecret: "s",
        llmMode: mode,
      }) as { properties: { llm: { system_messages: Array<{ content: string }>; tools?: unknown[] } } };

      assert.match(p.properties.llm.system_messages[0].content, /NEVER ASSERT CAUSATION/,
                   `Rule 2 missing in ${mode} mode`);
      assert.equal(p.properties.llm.tools?.length, AGENT_TOOLS.length, `tools missing in ${mode} mode`);
    }
  });
});

describe("preset resolution — ported from the SDK's presets.py", () => {
  /*
    THE REGRESSION THESE LOCK DOWN.

    A preset is derived from a vendor block and then replaces the fields it
    covers. Hand-writing both halves let them disagree: we claimed
    `deepgram_nova_3,openai_gpt_4o_mini` while sending an asr block with no
    model and an llm block with no url — so neither preset was ever justified,
    Agora returned 200, and the agent joined the channel deaf and mute.
  */
  test("nova-3 in params is what yields the ASR preset", () => {
    assert.equal(inferAsrPreset({ vendor: "deepgram", params: { model: "nova-3" } }), "deepgram_nova_3");
    // No model -> nothing to infer. This was the deaf agent.
    assert.equal(inferAsrPreset({ vendor: "deepgram", params: {} }), null);
    // BYOK and managed are mutually exclusive by construction.
    assert.equal(inferAsrPreset({ vendor: "deepgram", params: { model: "nova-3", key: "k" } }), null);
  });

  test("an api_key silently drops the LLM off the managed path", () => {
    const managed = { url: MANAGED_OPENAI_URL, params: { model: "gpt-4o-mini" } };
    assert.equal(inferLlmPreset(managed), "openai_gpt_4o_mini");
    assert.equal(inferLlmPreset({ ...managed, api_key: "sk-x" }), null);
  });

  test("the Groq path yields no LLM preset and keeps its url and key", () => {
    const props = {
      asr: { vendor: "deepgram", params: { model: "nova-3" } },
      llm: buildLlmVendor("groq", "gsk-test", "openai/gpt-oss-120b"),
    };
    const { preset, properties } = resolveSessionPresets(props);
    assert.equal(preset, "deepgram_nova_3", "Groq must not claim a managed LLM preset");
    assert.equal(properties.llm.api_key, "gsk-test");
    assert.match(String(properties.llm.url), /api\.groq\.com/);
    assert.equal(properties.llm.params.model, "openai/gpt-oss-120b");
  });

  test("stripping removes only what the preset covers", () => {
    const { properties } = resolveSessionPresets({
      asr: {
        vendor: "deepgram",
        params: { model: "nova-3", keyterm: "Redis", punctuation: true },
        language: "en-US",
      },
      llm: { url: MANAGED_OPENAI_URL, params: { model: "gpt-4o-mini", max_tokens: 1024 } },
    });
    // Covered by the preset -> gone.
    assert.equal(properties.asr.params.model, undefined);
    assert.equal(properties.llm.params.model, undefined);
    assert.equal("url" in properties.llm, false);
    // NOT covered -> kept. `language` in particular is kept by the SDK too.
    assert.equal(properties.asr.params.keyterm, "Redis");
    assert.equal(properties.asr.params.punctuation, true);
    assert.equal(properties.asr.language, "en-US");
    assert.equal(properties.llm.params.max_tokens, 1024);
  });
});
