import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  forwardDecision,
  isAgentTranscript,
  parseAgoraTranscript,
} from "../src/lib/agora-transcript.ts";

describe("Agora RTM transcript boundary", () => {
  test("normalizes documented field variants without losing finality", () => {
    const transcript = parseAgoraTranscript(
      JSON.stringify({
        transcript: " Redis memory is at 40 percent. ",
        stream_id: "1001",
        is_final: false,
        turn_id: "turn-9",
      }),
    );

    assert.deepEqual(transcript, {
      uid: 1001,
      text: "Redis memory is at 40 percent.",
      isFinal: false,
      messageId: "turn-9",
      object: "",
    });
  });

  test("treats absent finality as final and produces a stable fallback id", () => {
    const transcript = parseAgoraTranscript(
      { content: "The cache is fine.", userId: 1002 },
      () => 1234,
    );

    assert.equal(transcript?.isFinal, true);
    assert.equal(transcript?.messageId, "1002-1234");
  });

  test("rejects non-transcript RTM traffic instead of inventing a claim", () => {
    assert.equal(parseAgoraTranscript("not json"), null);
    assert.equal(parseAgoraTranscript({ uid: 1001 }), null);
  });

  test("keeps Echo audio outside the Slow Loop on both available signals", () => {
    const byUid = parseAgoraTranscript({ text: "Echo text", uid: 9000 });
    const byObject = parseAgoraTranscript({
      text: "Echo text",
      uid: 0,
      object: "assistant.transcript",
    });

    assert.equal(isAgentTranscript(byUid!), true);
    assert.equal(isAgentTranscript(byObject!), true);
  });
});

/* ========================================================================== */
describe("Who forwards what — the two-machine rule", () => {
  /* ======================================================================== */

  /**
   * §18 makes two machines with two UIDs a HARD requirement, and that is
   * exactly the configuration these tests exist for — it cannot be exercised
   * on one laptop, so it has to be pinned here instead.
   *
   * RTM broadcasts every transcript to every subscriber. A browser knows one
   * role for certain: its own. So each participant forwards only their own
   * speech.
   */

  const speech = (uid: number, text: string, over: Record<string, unknown> = {}) =>
    parseAgoraTranscript({ text, uid, is_final: true, ...over })!;

  const DEVOPS = 1001;
  const SUPPORT = 1002;

  test("a browser forwards its own speech", () => {
    assert.equal(
      forwardDecision(speech(DEVOPS, "Memory is at 40 percent"), DEVOPS),
      "forward",
    );
  });

  test("a browser does NOT forward another participant's speech", () => {
    // The bug this replaces: DevOps's console received Support's utterance over
    // RTM and forwarded it labelled "DevOps Lead". A MIS-sourced claim is worse
    // than an unsourced one — Rule 1 catches the second, nothing catches the
    // first, and the contradiction engine would then compare two people's
    // claims believing them to be one person's.
    assert.equal(
      forwardDecision(speech(SUPPORT, "cache read timeouts"), DEVOPS),
      "skip:not-mine",
    );
  });

  test("one utterance produces exactly ONE forward across two machines", () => {
    // The duplicate half of the same bug: both browsers forwarded, so every
    // sentence was extracted twice.
    const utterance = speech(SUPPORT, "Application logs show cache read timeouts");
    const decisions = [DEVOPS, SUPPORT].map((self) => forwardDecision(utterance, self));

    assert.deepEqual(decisions, ["skip:not-mine", "forward"]);
    assert.equal(decisions.filter((d) => d === "forward").length, 1);
  });

  test("Echo's own speech is never forwarded by anyone (G2)", () => {
    for (const self of [DEVOPS, SUPPORT]) {
      assert.equal(forwardDecision(speech(9000, "Echo speaking"), self), "skip:agent");
      assert.equal(
        forwardDecision(
          speech(0, "Echo speaking", { object: "assistant.transcription" }),
          self,
        ),
        "skip:agent",
      );
    }
  });

  test("partials are held back — extraction needs whole sentences", () => {
    assert.equal(
      forwardDecision(speech(DEVOPS, "Memory is at", { is_final: false }), DEVOPS),
      "skip:partial",
    );
  });

  test("the agent check runs before the ownership check", () => {
    // Order matters for diagnosis: an operator reading "skip:not-mine" against
    // uid 9000 would go hunting for a roster bug that does not exist.
    assert.equal(forwardDecision(speech(9000, "Echo"), DEVOPS), "skip:agent");
  });
});

/**
 * ── THE SUBSCRIPTION THAT WAS NEVER OPENED ──────────────────────────────────
 * `AgoraVoiceAI.init()` binds NO listeners. It validates the engines, stores
 * them on the singleton, and returns — read `_doInit` in the toolkit's
 * `dist/index.mjs`. The only call that reaches `bindRtcEvents()`, and so the
 * only call that ever attaches
 *
 *     rtcEngine.on("stream-message", ...)
 *
 * is `subscribeMessage(channel)`. Without it, `on(TRANSCRIPT_UPDATED, ...)`
 * listens to an emitter nothing emits into: the agent joins, the mic
 * publishes, Agora transcribes, and the console stays empty with no error
 * anywhere.
 *
 * That failure is silent by construction, so it is pinned in source rather
 * than left to a human noticing an empty dashboard. `voice-agent.ts` is
 * browser-only — it imports the RTC SDK at module scope — so this asserts on
 * the source text instead of importing it.
 */
describe("the transcript subscription is actually opened", () => {
  const source = readFileSync(
    new URL("../src/lib/agora/voice-agent.ts", import.meta.url),
    "utf8",
  );

  test("subscribeMessage is called — init() alone binds nothing", () => {
    assert.match(
      source,
      /this\.ai\.subscribeMessage\(/,
      "VoiceAgent.start() must call subscribeMessage(channel); init() attaches no listeners",
    );
  });

  test("it subscribes with the channel, never a hardcoded string", () => {
    assert.match(source, /this\.ai\.subscribeMessage\(channel\)/);
  });

  test("subscription happens after the handlers are registered", () => {
    const handler = source.indexOf("TRANSCRIPT_UPDATED");
    const subscribe = source.indexOf("subscribeMessage(channel)");
    assert.ok(handler > -1 && subscribe > -1);
    assert.ok(
      handler < subscribe,
      "register TRANSCRIPT_UPDATED before subscribing, or the first frames land with no listener",
    );
  });
});

describe("the toolkit's uid-0 sentinel", () => {
  /*
    The toolkit stamps the LOCAL user's transcriptions with a hardcoded
    `uid: "0"` (SELF_USER_ID in dist/index.mjs) rather than the real uid, and
    exposes no setter for it. Unmapped, every human turn failed the
    `uid !== selfUid` check and was silently dropped as "skip:not-mine" — the
    transcript panel stayed empty while the RTC stream was demonstrably alive.

    `voice-agent.ts::drain` now resolves 0 -> selfUid before this runs. These
    assert the decision either side of that mapping.
  */
  test("uid 0 unmapped is not mine — the bug", () => {
    assert.equal(
      forwardDecision(
        { uid: 0, text: "Redis is at 40 percent", isFinal: true, messageId: "m1", object: "" },
        1001,
      ),
      "skip:not-mine",
    );
  });

  test("mapped to the real uid it forwards — the fix", () => {
    assert.equal(
      forwardDecision(
        { uid: 1001, text: "Redis is at 40 percent", isFinal: true, messageId: "m1", object: "" },
        1001,
      ),
      "forward",
    );
  });

  test("the agent's own turns are still excluded (G2)", () => {
    assert.equal(
      forwardDecision(
        { uid: 9000, text: "Echo is on the bridge", isFinal: true, messageId: "m2", object: "" },
        1001,
      ),
      "skip:agent",
    );
  });
});
