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

  const DBA = 1003;

  /** Stand-in for the Roster: exactly who this console has been told about. */
  const roster =
    (map: Record<number, string>) =>
    (uid: number) =>
      (map[uid] ?? null) as never;

  const ROOM = roster({
    [DEVOPS]: "DevOps Lead",
    [SUPPORT]: "Support Engineer",
    [DBA]: "Database Admin",
  });

  test("one console minutes the WHOLE room, not just its operator", () => {
    /*
      Changed Sep 6, and it is a reversal.

      The rule was "forward only my own speech", which was right while each
      participant ran their own console. Once Echo began subscribing to
      `["*"]`, the toolkit started handing every speaker's finished turn to
      every console — so one console can record the whole bridge, and
      colleagues can join from any Agora client with no console of their own.

      Three speakers, one console, three forwards.
    */
    for (const uid of [DEVOPS, SUPPORT, DBA]) {
      assert.equal(forwardDecision(speech(uid, "a measured thing"), ROOM), "forward");
    }
  });

  test("an unknown uid is DROPPED, never guessed at", () => {
    /*
      The danger the old rule was protecting against, kept.

      Forwarding a stranger's words under some default role would put one
      person's sentence in another's mouth. §6.2 Rule 1 catches an unsourced
      claim; nothing downstream catches a mis-sourced one, and the
      contradiction engine would then compare two people believing them to be
      one. So a uid the Roster cannot name is skipped outright.
    */
    assert.equal(
      forwardDecision(speech(4242, "who even is this"), ROOM),
      "skip:unknown-uid",
    );
  });

  test("attribution comes from the Roster, not from whose browser this is", () => {
    // A console operated by DevOps still files Support's line as Support's.
    const support = speech(SUPPORT, "cache read timeouts");
    assert.equal(forwardDecision(support, ROOM), "forward");
    assert.equal(ROOM(support.uid), "Support Engineer");
  });

  test("Echo's own speech is never forwarded (G2)", () => {
    assert.equal(forwardDecision(speech(9000, "Echo speaking"), ROOM), "skip:agent");
    assert.equal(
      forwardDecision(
        speech(0, "Echo speaking", { object: "assistant.transcription" }),
        ROOM,
      ),
      "skip:agent",
    );
  });

  test("partials are held back — extraction needs whole sentences", () => {
    assert.equal(
      forwardDecision(speech(DEVOPS, "Memory is at", { is_final: false }), ROOM),
      "skip:partial",
    );
  });

  test("the agent check runs before the roster lookup", () => {
    // Order matters for diagnosis: an operator reading "skip:unknown-uid"
    // against uid 9000 would go hunting for a Roster bug that does not exist.
    // Echo is deliberately absent from this roster, as it is from the real one.
    assert.equal(forwardDecision(speech(9000, "Echo"), ROOM), "skip:agent");
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
  /*
    A Roster that names nobody: the state before `refreshRoster` has answered,
    and the state for a uid that joined without a roster entry.
  */
  const namesNobody = () => null;
  const roster = (map: Record<number, string>) =>
    (uid: number) => (map[uid] ?? null) as never;

  test("an unnameable uid is dropped, not guessed at", () => {
    // The toolkit stamps `uid: "0"` on every user transcription and exposes no
    // setter for it. `voice-agent.ts::emit` resolves 0 -> the real speaker via
    // `stream_id` before this runs; if that resolution ever fails, the turn
    // must be dropped rather than filed under whoever is sitting here.
    assert.equal(
      forwardDecision(
        { uid: 0, text: "Redis is at 40 percent", isFinal: true, messageId: "m1", object: "" },
        namesNobody,
      ),
      "skip:unknown-uid",
    );
  });

  test("a uid the Roster can name forwards", () => {
    assert.equal(
      forwardDecision(
        { uid: 1001, text: "Redis is at 40 percent", isFinal: true, messageId: "m1", object: "" },
        roster({ 1001: "DevOps Lead" }),
      ),
      "forward",
    );
  });

  test("the agent's own turns are still excluded (G2)", () => {
    // Checked FIRST, and deliberately: an operator reading "skip:unknown-uid"
    // against uid 9000 would go hunting for a Roster bug that does not exist.
    assert.equal(
      forwardDecision(
        { uid: 9000, text: "Echo is on the bridge", isFinal: true, messageId: "m2", object: "" },
        namesNobody,
      ),
      "skip:agent",
    );
  });

  test("a partial is never forwarded", () => {
    assert.equal(
      forwardDecision(
        { uid: 1001, text: "Redis is at", isFinal: false, messageId: "m3", object: "" },
        roster({ 1001: "DevOps Lead" }),
      ),
      "skip:partial",
    );
  });
});

describe("three humans on one bridge — the console minutes the room", () => {
  /*
    ── WHY THIS IS NO LONGER "ONLY MY OWN SPEECH" ────────────────────────────
    The old rule dropped everyone else's turn as `skip:not-mine`, which was
    right while each participant ran their own console and forwarded their own
    line. It stopped being right the moment Echo subscribed to `["*"]`: three
    people joined on three machines, could all hear each other, and Echo heard
    none of them.

    The guarantee that must NOT weaken is that a sentence is never filed under
    the wrong person. That is now achieved by refusing unnameable uids rather
    than by refusing everyone but ourselves.
  */
  const room = (uid: number) =>
    ({ 1001: "DevOps Lead", 1002: "Support Engineer", 1003: "Database Admin" }[uid] ?? null) as never;

  test("every named participant forwards, not just this browser's owner", () => {
    for (const uid of [1001, 1002, 1003]) {
      assert.equal(
        forwardDecision(
          { uid, text: "Redis looks fine", isFinal: true, messageId: `m${uid}`, object: "" },
          room,
        ),
        "forward",
        `uid ${uid} was dropped — Echo would be deaf to that person`,
      );
    }
  });

  test("a stranger who never reached the Roster is still refused", () => {
    // The protection the old rule provided, kept: an unattributable turn is
    // dropped rather than guessed at.
    assert.equal(
      forwardDecision(
        { uid: 4242, text: "who am I", isFinal: true, messageId: "m9", object: "" },
        room,
      ),
      "skip:unknown-uid",
    );
  });
});
