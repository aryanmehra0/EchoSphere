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
  FAST_LOOP_SYSTEM_PROMPT,
  TURN_DETECTION,
  buildAgentPayload,
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
    assert.equal(TURN_DETECTION.interrupt_duration_ms, 300);
  });

  test("VAD is agora_vad, never server_vad", () => {
    assert.equal(TURN_DETECTION.mode, "agora_vad");
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

  test("the payload carries the prompt, the tools and the VAD config", () => {
    const payload = buildAgentPayload({
      channel: "inc-4417",
      agentUid: AGENT_UID,
      agentRtcToken: "fake-token",
      openAiApiKey: "sk-test",
    });

    assert.equal(payload.properties.channel, "inc-4417");
    assert.equal(payload.properties.agent_rtc_uid, String(AGENT_UID));
    assert.equal(payload.properties.llm.vendor, "openai");
    assert.equal(payload.properties.llm.model, "gpt-4o-realtime-preview");
    assert.equal(payload.properties.turn_detection.interrupt_duration_ms, 300);
    assert.equal(payload.properties.llm.tools.length, AGENT_TOOLS.length);
    assert.match(
      payload.properties.llm.system_messages[0].content,
      /NEVER ASSERT CAUSATION/,
    );
  });

  test("the agent has no greeting — silence is the default state", () => {
    const payload = buildAgentPayload({
      channel: "c", agentUid: AGENT_UID, agentRtcToken: "t", openAiApiKey: "k",
    });
    assert.equal(
      payload.properties.llm.greeting_message,
      "",
      "a greeting would contradict the WHEN TO SPEAK section",
    );
  });

  test("ASR keyword biasing covers the demo's technical vocabulary", () => {
    const payload = buildAgentPayload({
      channel: "c", agentUid: AGENT_UID, agentRtcToken: "t", openAiApiKey: "k",
    });
    const kw = payload.properties.asr.keywords;
    // "Redis" reliably transcribes as "read us" without biasing, and the
    // extraction model then invents an entity nobody mentioned.
    for (const term of ["Redis", "VPC", "us-east-1a", "failover"]) {
      assert.ok(kw.includes(term), `ASR biasing is missing "${term}"`);
    }
  });
});
