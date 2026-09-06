import { describe, test } from "node:test";
import assert from "node:assert/strict";

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
