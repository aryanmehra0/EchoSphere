import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_UID,
  OBSERVER_UID,
  allocateHumanUid,
  getObserverView,
  getRoster,
  isAuthorizedRole,
  putEntry,
  RosterWriteError,
  touchExpiry,
  __resetRoster,
} from "../src/lib/server/roster.ts";
import {
  AGENT_TOOLS,
  CRITICAL_TOOLS,
  FAST_LOOP_MODEL,
  FAST_LOOP_SYSTEM_PROMPT,
  GROQ_CHAT_COMPLETIONS_URL,
  TURN_DETECTION,
  buildAgentPayload,
  buildTtsConfig,
} from "../src/lib/server/agent-config.ts";

/**
 * ============================================================================
 * S1 — Fast Loop identity layer
 * ============================================================================
 *
 * Covers the parts of S1 that are testable WITHOUT live Agora credentials:
 * the Roster invariant (closes G3), the agent-exclusion set the Observer needs
 * (precondition for G2), and the epistemic content of the Fast Loop prompt.
 *
 * NOT covered here, and honestly out of reach until credentials exist:
 *   ⊘ real token signature validity        — needs a real app certificate
 *   ⊘ Agora accepts the agent payload      — needs a live project
 *   ⊘ event 104 actually fires             — needs a >1h session (S6)
 *   ⊘ injection latency < 500ms            — S0 Bridge Spike
 *
 * The S1 exit gate in docs/task.md ("two humans + Echo in a channel; every UID
 * resolves to a role") is a LIVE gate. This suite makes the failure modes that
 * can be caught statically get caught statically.
 */

beforeEach(() => __resetRoster());

/* ========================================================================== */
describe("Roster — the write-before-token invariant (closes G3)", () => {
  /* ======================================================================== */

  test("human UIDs are allocated sequentially and never collide", async () => {
    const a = allocateHumanUid("inc-1");
    await putEntry({
      channel: "inc-1",
      uid: a,
      role: "DevOps Lead",
      kind: "human",
      authorized: true,
      issuedAt: 1,
      expiresAt: 2,
    });
    const b = allocateHumanUid("inc-1");

    assert.notEqual(a, b, "a taken UID was handed out twice");
    assert.ok(a > 1000 && b > 1000);
  });

  test("UIDs are scoped per channel", async () => {
    const a = allocateHumanUid("inc-1");
    await putEntry({
      channel: "inc-1",
      uid: a,
      role: "DevOps Lead",
      kind: "human",
      authorized: true,
      issuedAt: 1,
      expiresAt: 2,
    });

    // A different bridge starts fresh — 1001 on inc-2 is a different person.
    assert.equal(allocateHumanUid("inc-2"), a);
  });

  test("a malformed entry is rejected rather than silently stored", async () => {
    // Every rejection here is a token that never gets issued, which is the
    // whole point: an unattributable participant must not reach the channel.
    await assert.rejects(
      () =>
        putEntry({
          channel: "",
          uid: 1001,
          role: "DevOps Lead",
          kind: "human",
          authorized: true,
          issuedAt: 1,
          expiresAt: 2,
        }),
      RosterWriteError,
    );

    await assert.rejects(
      () =>
        putEntry({
          channel: "inc-1",
          uid: -5,
          role: "DevOps Lead",
          kind: "human",
          authorized: true,
          issuedAt: 1,
          expiresAt: 2,
        }),
      RosterWriteError,
    );
  });

  test("only DevOps Lead may approve critical actions", () => {
    // An allow-list, so adding a participant type can never accidentally
    // grant approval authority (v6 §10.2).
    assert.equal(isAuthorizedRole("DevOps Lead"), true);
    assert.equal(isAuthorizedRole("Support Engineer"), false);
    assert.equal(isAuthorizedRole("Database Admin"), false);
    assert.equal(isAuthorizedRole("Echo"), false);
  });

  test("Echo is never authorized — it is the thing being gated", () => {
    assert.equal(isAuthorizedRole("Echo"), false);
  });
});

/* ========================================================================== */
describe("Observer view — agent exclusion (precondition for G2)", () => {
  /* ======================================================================== */

  const seed = async () => {
    await putEntry({
      channel: "inc-1", uid: 1001, role: "DevOps Lead", kind: "human",
      authorized: true, issuedAt: 1, expiresAt: 2,
    });
    await putEntry({
      channel: "inc-1", uid: 1002, role: "Support Engineer", kind: "human",
      authorized: false, issuedAt: 1, expiresAt: 2,
    });
    await putEntry({
      channel: "inc-1", uid: AGENT_UID, role: "Echo", kind: "agent",
      authorized: false, issuedAt: 1, expiresAt: 2,
    });
    await putEntry({
      channel: "inc-1", uid: OBSERVER_UID, role: "Echo", kind: "observer",
      authorized: false, issuedAt: 1, expiresAt: 2,
    });
  };

  test("every UID on the channel resolves to a role — the S1 gate", async () => {
    await seed();
    const { roles } = await getObserverView("inc-1");
    const entries = await getRoster("inc-1");

    for (const e of entries) {
      assert.ok(roles[e.uid], `uid ${e.uid} has no role — attribution would fail`);
    }
  });

  test("the exclusion set contains Echo and the Observer, and no human", async () => {
    await seed();
    const { exclude } = await getObserverView("inc-1");

    assert.ok(exclude.includes(AGENT_UID), "Echo's audio would be transcribed (G2)");
    assert.ok(exclude.includes(OBSERVER_UID));
    assert.ok(!exclude.includes(1001), "a human was excluded — claims would vanish");
    assert.ok(!exclude.includes(1002));
  });

  test("exclusion is by kind, not by hardcoded UID", async () => {
    // A second agent must be excluded too. Keying on the number 9000 would
    // silently let it through.
    await seed();
    await putEntry({
      channel: "inc-1", uid: 9500, role: "Echo", kind: "agent",
      authorized: false, issuedAt: 1, expiresAt: 2,
    });

    const { exclude } = await getObserverView("inc-1");
    assert.ok(exclude.includes(9500), "a second agent escaped the exclusion set");
  });

  test("renewal extends expiry without changing identity (W7)", async () => {
    await seed();
    const renewed = await touchExpiry("inc-1", AGENT_UID, 999_999);

    assert.equal(renewed.uid, AGENT_UID, "renewal must not change the UID");
    assert.equal(renewed.role, "Echo");
    assert.equal(renewed.expiresAt, 999_999);
  });

  test("renewing an unknown UID fails loudly", async () => {
    await assert.rejects(
      () => touchExpiry("inc-1", 4242, 999),
      RosterWriteError,
    );
  });
});

/* ========================================================================== */
describe("Fast Loop prompt — §14.1 epistemic rules must survive edits", () => {
  /* ======================================================================== */

  test("all four epistemic rules are present", () => {
    const P = FAST_LOOP_SYSTEM_PROMPT;
    assert.match(P, /ATTRIBUTION IS MANDATORY/, "Rule 1 missing");
    assert.match(P, /NEVER ASSERT CAUSATION/, "Rule 2 missing");
    assert.match(P, /NEVER ANSWER FROM MEMORY/, "Rule 3 missing");
    assert.match(P, /IF THE RECORD DOES NOT CONTAIN IT, SAY SO/, "Rule 4 missing");
  });

  test("the prompt states silence is the default", () => {
    assert.match(FAST_LOOP_SYSTEM_PROMPT, /default is ABSOLUTE SILENCE/i);
  });

  test("the prompt forbids completing a CRITICAL action from voice", () => {
    assert.match(
      FAST_LOOP_SYSTEM_PROMPT,
      /never complete one on verbal agreement alone/i,
      "the voice-is-not-authorization rule (G7) is missing from the prompt",
    );
  });

  test("the prompt names itself a recording secretary, not a diagnostician", () => {
    assert.match(FAST_LOOP_SYSTEM_PROMPT, /recording secretary, not a diagnostician/i);
  });
});

/* ========================================================================== */
describe("Agent configuration", () => {
  /* ======================================================================== */

  test("barge-in is 300ms, not v5's 160ms", () => {
    // At 160ms Echo interrupted on breaths and back-channel "mm-hm".
    assert.equal(
      TURN_DETECTION.config.start_of_speech.vad_config.interrupt_duration_ms,
      300,
    );
  });

  test("turn detection uses the CURRENT nested shape, not the deprecated flat one", () => {
    /*
      The regression this pins made the product deaf.

      `mode` used to be "agora_vad". The API accepts only "default" there —
      "agora_vad" belongs to `type`, which is deprecated — and the flat timing
      keys were deprecated in favour of config.start_of_speech/end_of_speech.

      An invalid mode means turn detection does not apply: no VAD, no turn
      boundaries, no transcripts. The create call still returns 200, because
      Agora accepts unknown keys and validates only what it recognises.
    */
    assert.equal(TURN_DETECTION.mode, "default", "mode accepts only 'default'");
    assert.ok(TURN_DETECTION.config, "timing config must be nested under config");
    assert.equal(TURN_DETECTION.config.start_of_speech.mode, "vad");
    assert.equal(TURN_DETECTION.config.end_of_speech.mode, "vad");
    assert.equal(
      TURN_DETECTION.config.end_of_speech.vad_config.silence_duration_ms,
      640,
    );

    // The deprecated flat keys must not come back.
    const flat = TURN_DETECTION as Record<string, unknown>;
    for (const key of ["interrupt_duration_ms", "prefix_padding_ms", "silence_duration_ms", "threshold"]) {
      assert.equal(flat[key], undefined, `deprecated flat key "${key}" is back`);
    }
  });

  test("query_incident_state exists — the channel v5 lacked (G1)", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    assert.ok(
      names.includes("query_incident_state"),
      "without this, 3 of Echo's 4 speaking conditions are unimplementable",
    );
  });

  test("both infrastructure-touching tools are classified CRITICAL", () => {
    assert.deepEqual(
      CRITICAL_TOOLS.sort(),
      ["execute_runbook_script", "page_oncall_team"].sort(),
    );
  });

  test("every tool declares a tier — an unclassified tool is ungated", () => {
    const TIERS = new Set(["READ", "ADVISORY", "CRITICAL"]);
    for (const t of AGENT_TOOLS) {
      assert.ok(TIERS.has(t.tier), `tool ${t.name} has no valid tier`);
    }
  });

  /** The cascaded Fast Loop config, as `/api/invite-agent` builds it. */
  const samplePayload = (channel = "inc-4417", toolBaseUrl: string | null = "https://echo.example") =>
    buildAgentPayload({
      channel,
      agentUid: AGENT_UID,
      // Agora subscribes to exactly one participant; there is no wildcard.
      userUid: 1001,
      agentRtcToken: "fake-token",
      groqApiKey: "gsk-test",
      tts: { vendor: "elevenlabs", apiKey: "el-test" },
      toolBaseUrl,
      // Explicit: these assertions are about the BYOK/Groq shape - `url`,
      // `api_key` and `style` exist only on that path. The managed path is
      // covered separately in agent-tools.test.ts.
      llmMode: "groq" as const,
    });

  test("the payload carries the prompt, the tools and the VAD config", () => {
    const payload = samplePayload();

    assert.equal(payload.properties.channel, "inc-4417");
    assert.equal(payload.properties.agent_rtc_uid, String(AGENT_UID));
    assert.equal(payload.properties.llm.url, GROQ_CHAT_COMPLETIONS_URL);
    // The model lives inside `params`, not beside `url`. A top-level `model`
    // is an unknown key that Agora forwards untouched, so the request reached
    // Groq with no model at all — the LLM turn never completed and the
    // pipeline emitted no transcript, while /bridge/say kept working because
    // speaking a supplied line bypasses the LLM.
    assert.equal(payload.properties.llm.params.model, FAST_LOOP_MODEL);
    assert.equal(payload.properties.llm.style, "openai");
    assert.equal(
      payload.properties.turn_detection.config.start_of_speech.vad_config
        .interrupt_duration_ms,
      300,
    );
    assert.equal(payload.properties.llm.tools?.length, AGENT_TOOLS.length);
    assert.match(
      payload.properties.llm.system_messages[0].content,
      /NEVER ASSERT CAUSATION/,
    );
  });

  test("every tool is a REST tool pointed at the Slow Loop", () => {
    /*
      Agora REST tools are HTTP calls the Engine makes ITSELF, and the shape is
      strict: `type: "function"` plus `server` is what declares one. Missing
      either is a 400 at create time — which is how this was found, twice:

          400  Missing required field: llm.tools.0.type
          400  Missing required field: llm.tools.0.server

      Before `enable_tools` was set, Agora never looked at the array at all, so
      a malformed tools block sat there inert for weeks. Echo then answered
      from the model's own memory instead of from the Ledger.
    */
    const tools = samplePayload("c", "https://echo.example").properties.llm.tools ?? [];
    assert.equal(tools.length, AGENT_TOOLS.length);

    for (const tool of tools) {
      assert.equal(tool.type, "function");
      assert.ok(tool.function.name, "a tool needs a name the model can call");
      assert.equal(tool.server.method, "POST");
      assert.match(tool.server.url, /^https:\/\/echo\.example\/tools\//);
      assert.ok(tool.server.timeout_ms, "an untimed tool can hang the turn");
    }

    const read = tools.find((t) => t.function.name === "query_incident_state");
    assert.ok(read, "the Ledger read tool must be present");
    assert.match(read.server.url, /query_incident_state$/);
  });

  test("no public URL means NO tools, not broken ones", () => {
    /*
      Agora calls tools from its own servers, so a localhost URL fails on their
      side invisibly. A tool that always fails is worse than an absent one: the
      model retries, collects errors, and falls back on its own memory — the
      exact hallucination this product exists to prevent.
    */
    const props = samplePayload("c", null).properties;
    assert.equal(props.llm.tools, undefined, "tools must be omitted entirely");
    assert.equal(
      props.advanced_features.enable_tools,
      false,
      "enable_tools must track whether tools were actually attached",
    );
  });

  test("the agent has no greeting — silence is the default state", () => {
    assert.equal(
      samplePayload("c").properties.llm.greeting_message,
      "",
      "a greeting would contradict the WHEN TO SPEAK section",
    );
  });

  test("the agent subscribes to the WHOLE room, not one participant", () => {
    /*
      CORRECTION, Sep 6 — this test previously asserted the opposite, and was
      the thing keeping the bug in place.

      It pinned `["1001"]` on the claim that `"*"` is "a user id, not a
      wildcard". Agora's documentation for the field says plainly:

        "The `*` selector includes all UIDs present in the channel, which may
         include other AI agents."

      Confirmed against the live API too — `["*"]`, one uid, and three explicit
      uids are all accepted and all start an agent. The earlier `["*"]` trial
      produced no transcripts because the `asr` block was broken at the same
      time, not because the wildcard matched nobody.

      With one uid, Echo heard whoever pressed J first and was deaf to the
      other two people on the bridge — which is most of the product. Each
      browser still forwards only its own speech (`forwardDecision`), so
      attribution stays correct with three speakers.
    */
    const uids = samplePayload("c").properties.remote_rtc_uids;
    assert.deepEqual(uids, ["*"], "Echo must subscribe to every participant");
  });

  test("ASR names a vendor — without one Agora runs no recogniser at all", () => {
    /*
      The regression this pins is the one that made the product deaf.

      The block used to be `{ language, keywords: [...] }` with no `vendor`.
      Agora returned 200, the agent joined, and not one word was ever
      transcribed — speech reached the channel and produced nothing, with no
      error on any surface. `vendor` is what selects a recogniser; everything
      else is forwarded to it unchecked.
    */
    const payload = samplePayload("c");
    assert.equal(payload.properties.asr.vendor, "deepgram", "ASR must name a vendor");
    assert.ok(payload.properties.asr.params, "vendor options belong under params");

    /*
      A managed vendor is activated by the top-level `preset`, NOT by the
      vendor block alone. The SDK sends { appid, name, preset, properties },
      and for a keyless deepgram block it derives `deepgram_nova_3` and strips
      `params.model` because the preset carries it.

      Sending the block with no preset is what left the agent deaf: Agora
      accepted the payload, never activated the recogniser, and transcribed
      nothing while reporting healthy.
    */
    assert.equal(payload.preset, "deepgram_nova_3", "managed ASR needs its preset");
    assert.ok(
      !("model" in payload.properties.asr.params),
      "the preset carries the model; sending both makes the preset not apply",
    );
  });

  test("ASR params carry the language Deepgram actually reads", () => {
    /*
      `params.language` was absent on Sep 6 and every transcribed turn came
      back EMPTY — 44 turns segmented, not one word. It was removed on the
      belief that the session layer "overwrites it from turn detection", but
      `_resolve_asr_config` assigns the TOP-LEVEL `language` and never touches
      `params`. Both are on the wire in the working quickstart payload, and
      they are different fields.

      `en`, not the `en-US` interaction language — this mirrors
      `DeepgramSTT(model="nova-3", language="en")`.
    */
    const params = samplePayload("c").properties.asr.params;
    assert.equal(params.language, "en", "Deepgram gets no language to run in");
  });

  test("ASR sends nothing beyond the payload proven to transcribe", () => {
    /*
      Agora validates `vendor` and forwards `params` unchecked, so an option
      the managed adapter dislikes cannot fail loudly — it fails as silence.
      `keyterm` (one space-separated string), `smart_format` and `punctuation`
      were all being sent and none appear in a payload observed to work.

      This is a floor, not a ban: re-add one, run `npm run demo speech`, and
      update this list only once that run actually returns text.
    */
    const params = samplePayload("c").properties.asr.params;
    assert.deepEqual(Object.keys(params).sort(), ["language"]);
  });

  test("ASR language stays in step with turn detection", () => {
    // The SDK treats turn detection as the single source of truth for the
    // interaction language and OVERWRITES the ASR field with it, so a
    // mismatch here is silently discarded rather than honoured.
    const props = samplePayload("c").properties;
    assert.equal(props.asr.language, props.turn_detection.language);
  });
});

/* ========================================================================== */
describe("TTS config — the one thing Agora will NOT catch for us", () => {
  /* ======================================================================== */

  /**
   * These tests exist because of a measured fact, not a hypothetical.
   *
   * A control probe sent Agora `tts: { vendor: "elevenlabs", params: {
   * totally_wrong_param_name: "x" } }` and Agora returned HTTP 200, RUNNING.
   * It validates only that `vendor` is one it recognises; `params` is forwarded
   * to the vendor adapter unchecked.
   *
   * So a typo in a param name does not fail at create time. It produces an
   * agent that joins, reports healthy, and never makes a sound — with no error
   * on any surface. These assertions are the only automated defence.
   */

  test("a tts block is always emitted — without one the agent is rejected", () => {
    // Agora's error for a missing block is `properties: tts.addon not found`,
    // which is the one TTS failure that IS loud. Keep it impossible.
    const payload = buildAgentPayload({
      channel: "c",
      agentUid: AGENT_UID,
      userUid: 1001,
      agentRtcToken: "t",
      groqApiKey: "gsk-test",
      tts: { vendor: "elevenlabs", apiKey: "el-test" },
    });
    assert.ok(payload.properties.tts, "no tts block — the agent cannot start");
    assert.ok(payload.properties.tts.vendor, "tts block has no vendor");
  });

  test("ElevenLabs reads `key`", () => {
    const tts = buildTtsConfig({ vendor: "elevenlabs", apiKey: "el-secret" });
    assert.equal(tts.vendor, "elevenlabs");
    assert.equal(
      (tts.params as Record<string, unknown>).key,
      "el-secret",
      "ElevenLabs' adapter reads `key`; anything else yields a silent agent",
    );
  });

  test("Sarvam reads `api_subscription_key`, NOT `key`", () => {
    // This asymmetry is the single easiest way to end up with a mute Echo.
    const tts = buildTtsConfig({ vendor: "sarvam", apiKey: "sv-secret" });
    const params = tts.params as Record<string, unknown>;

    assert.equal(tts.vendor, "sarvam");
    assert.equal(params.api_subscription_key, "sv-secret");
    assert.equal(
      params.key,
      undefined,
      "Sarvam ignores `key` — sending it instead of api_subscription_key is silent failure",
    );
  });

  test("the key is never dropped, whichever vendor is selected", () => {
    for (const vendor of ["elevenlabs", "sarvam"] as const) {
      const params = buildTtsConfig({ vendor, apiKey: "THE-KEY" }).params;
      assert.ok(
        Object.values(params).includes("THE-KEY"),
        `${vendor}: the api key did not reach params at all`,
      );
    }
  });

  test("ElevenLabs uses a low-latency model", () => {
    // We already spent §12.1's budget on the cascade; a slow TTS model on top
    // pushes mouth-to-ear somewhere a conversation stops feeling live.
    const params = buildTtsConfig({ vendor: "elevenlabs", apiKey: "k" })
      .params as Record<string, unknown>;
    assert.match(String(params.model_id), /flash/i);
  });

  test("Sarvam carries a speaker and a language", () => {
    const params = buildTtsConfig({ vendor: "sarvam", apiKey: "k" })
      .params as Record<string, unknown>;
    assert.ok(params.speaker, "Sarvam requires a speaker");
    assert.ok(params.target_language_code, "Sarvam requires a language code");
  });

  test("Sarvam pins an explicit model — never Agora's default", () => {
    // This is a scar, not a preference. Agora's Sarvam adapter defaulted to
    // `bulbul:v2`; Sarvam deprecated v2 mid-session and every agent went
    // silent — RUNNING, healthy, mute, no error anywhere. Pinning the model
    // turns a future deprecation into a loud 400 on our own probe.
    const params = buildTtsConfig({ vendor: "sarvam", apiKey: "k" })
      .params as Record<string, unknown>;
    assert.ok(params.model, "no model pinned — an upstream default can go silent on us");
    assert.match(String(params.model), /^bulbul:v[3-9]/, "v2 is deprecated");
  });

  test("the default Sarvam speaker is compatible with the pinned model", () => {
    // Speakers are model-scoped. v2 voices (anushka, abhilash, …) are rejected
    // outright by v3, and the rejection surfaces only as silence in the agent.
    const params = buildTtsConfig({ vendor: "sarvam", apiKey: "k" })
      .params as Record<string, unknown>;
    const V2_ONLY = ["anushka", "abhilash", "manisha", "vidya", "arya", "karun", "hitesh"];
    assert.ok(
      !V2_ONLY.includes(String(params.speaker)),
      `"${params.speaker}" is a bulbul:v2 voice and is rejected by v3`,
    );
  });
});
