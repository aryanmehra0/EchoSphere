import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  forgetAgent,
  getActiveAgent,
  rememberAgent,
} from "../src/lib/server/active-agents.ts";

/**
 * Echo's session lifecycle — v6 W1.
 *
 * These exist because on Aug 31 it turned out Echo had NEVER spoken. Every
 * other link in the chain worked — tokens minted, RTC joined, claims
 * extracted, contradictions detected and drawn on the dashboard — and the
 * console never invited an agent, so the Bridge Controller had nothing to
 * speak through. Nothing errored. It was simply silent, which is the hardest
 * kind of defect to notice and the worst one to discover on stage.
 */

const HOUR = 3_600_000;

describe("Echo's session lifecycle", () => {
  beforeEach(() => {
    forgetAgent("inc-4417");
    forgetAgent("inc-other");
  });

  test("a channel with no agent reports none", () => {
    assert.equal(getActiveAgent("inc-4417"), null);
  });

  test("one agent per channel — two consoles must not summon two Echoes", () => {
    /*
      §18 makes two humans on two machines a HARD requirement, and both their
      consoles join the same channel. Without idempotency both would invite,
      and the room would get two Echoes answering every question in slightly
      different words — which is indistinguishable, to a judge, from the
      product being broken.
    */
    rememberAgent({
      agentId: "agent-alpha",
      channel: "inc-4417",
      startedAt: Date.now(),
      expiresAt: Date.now() + HOUR, userUid: 1001, subscribedUids: [1001],
    });

    const secondConsoleSees = getActiveAgent("inc-4417");
    assert.equal(secondConsoleSees?.agentId, "agent-alpha");
  });

  test("channels are isolated from each other", () => {
    rememberAgent({
      agentId: "agent-alpha",
      channel: "inc-4417",
      startedAt: Date.now(),
      expiresAt: Date.now() + HOUR, userUid: 1001, subscribedUids: [1001],
    });
    assert.equal(getActiveAgent("inc-other"), null);
  });

  test("an expired agent is NOT reused", () => {
    // Reusing a dead agent is worse than inviting a new one: the room sits
    // waiting for a voice that can never come back, and every retry is
    // answered with the same corpse.
    rememberAgent({
      agentId: "agent-stale",
      channel: "inc-4417",
      startedAt: Date.now() - 2 * HOUR,
      expiresAt: Date.now() - 1000, userUid: 1001, subscribedUids: [1001],
    });

    assert.equal(
      getActiveAgent("inc-4417"),
      null,
      "an agent past its token window must not be handed out again",
    );
  });

  test("forgetting returns the agent so the caller can stop it at Agora", () => {
    // Leaving the RTC channel does NOT stop the Cloud Agent — it keeps
    // running, and billing, until Agora times it out. The stop route needs
    // the id back to issue the leave.
    rememberAgent({
      agentId: "agent-alpha",
      channel: "inc-4417",
      startedAt: Date.now(),
      expiresAt: Date.now() + HOUR, userUid: 1001, subscribedUids: [1001],
    });

    assert.equal(forgetAgent("inc-4417")?.agentId, "agent-alpha");
    assert.equal(getActiveAgent("inc-4417"), null);
    assert.equal(forgetAgent("inc-4417"), null, "stopping twice is not an error");
  });

  test("re-inviting after a stop yields a fresh agent", () => {
    rememberAgent({
      agentId: "agent-one",
      channel: "inc-4417",
      startedAt: Date.now(),
      expiresAt: Date.now() + HOUR, userUid: 1001, subscribedUids: [1001],
    });
    forgetAgent("inc-4417");
    rememberAgent({
      agentId: "agent-two",
      channel: "inc-4417",
      startedAt: Date.now(),
      expiresAt: Date.now() + HOUR, userUid: 1001, subscribedUids: [1001],
    });

    assert.equal(getActiveAgent("inc-4417")?.agentId, "agent-two");
  });
});
