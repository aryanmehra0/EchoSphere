import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentPayload,
  buildSystemPrompt,
  buildToolsBlock,
  FAST_LOOP_MODEL,
  FAST_LOOP_SYSTEM_PROMPT,
  NO_TOOLS_ADDENDUM,
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
  test("with tools, the prompt is exactly the reviewed constant", () => {
    // Not "starts with" — the epistemic rules must not acquire an invisible
    // tail in the normal case.
    assert.equal(buildSystemPrompt(true), FAST_LOOP_SYSTEM_PROMPT);
  });

  test("without tools, it says so rather than leaving the model stuck", () => {
    const prompt = buildSystemPrompt(false);
    assert.ok(prompt.startsWith(FAST_LOOP_SYSTEM_PROMPT));
    assert.ok(prompt.includes(NO_TOOLS_ADDENDUM.trim().split("\n")[0]));
  });

  test("the addendum does not relax Rule 3, it reports it cannot be met", () => {
    const prompt = buildSystemPrompt(false);
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
        /NEVER ANSWER FROM MEMORY/.test(buildSystemPrompt(enabled)),
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
