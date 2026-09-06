/**
 * Normalize the transcript envelopes emitted by Agora Conversational AI.
 *
 * Agora has used several field names across agent versions. Keeping this
 * parser pure makes that vendor boundary executable and keeps the reducer's
 * transcript contract stable.
 */
import type { ParticipantRole } from "./types";

export interface AgoraTranscript {
  uid: number;
  text: string;
  isFinal: boolean;
  messageId: string;
  object: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function firstText(record: UnknownRecord, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Returns null for non-transcript RTM traffic instead of guessing. */
/**
 * ⚠️ NOT ON THE LIVE PATH since the Agora toolkit landed.
 *
 * Transcripts now arrive already parsed as `TranscriptHelperItem` from
 * `agora-agent-client-toolkit` (see `lib/agora/voice-agent.ts`), which reads
 * the RTC data stream rather than raw RTM frames. This function survives as
 * the RTM wire-format parser and as the test helper that builds transcripts
 * for `forwardDecision` — which IS live, and is what keeps two machines from
 * double-forwarding or mis-attributing speech.
 *
 * Do not wire this back into the bridge without checking why it was replaced:
 * a hand-rolled RTM listener received nothing for days, because Conversational
 * AI transcripts do not travel on RTM.
 */
export function parseAgoraTranscript(raw: unknown, now = Date.now): AgoraTranscript | null {
  let payload = raw;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }

  const record = asRecord(payload);
  if (!record) return null;

  const text = firstText(record, ["text", "transcript", "content"]);
  if (!text) return null;

  const uidValue =
    record.stream_id ?? record.streamId ?? record.uid ?? record.user_id ?? record.userId;
  const parsedUid = Number(uidValue);
  const uid = Number.isFinite(parsedUid) ? parsedUid : 0;
  const finalValue = record.is_final ?? record.isFinal ?? record.final;
  const messageId =
    firstText(record, ["message_id", "messageId", "turn_id", "turnId"]) ||
    `${uid}-${now()}`;

  return {
    uid,
    text,
    // Missing finality is safer as final: duplicate partials are harmlessly
    // collapsed by the reducer, while a dropped final is unrecoverable.
    isFinal: finalValue === undefined ? true : Boolean(finalValue),
    messageId,
    object: firstText(record, ["object"]),
  };
}

/** Echo and any Agora assistant payload must never re-enter the Slow Loop. */
export function isAgentTranscript(transcript: AgoraTranscript, agentUid = 9000): boolean {
  return transcript.uid === agentUid || /assistant/i.test(transcript.object);
}

/** Why a transcript was or was not forwarded — kept explicit so it is loggable. */
export type ForwardDecision =
  | "forward"
  | "skip:partial"
  | "skip:agent"
  | "skip:unknown-uid";

/**
 * Resolve a speaker's role from the Roster. `null` means "not a known human",
 * which is the ONLY safe answer when the uid has no entry.
 */
export type RoleResolver = (uid: number) => ParticipantRole | null;

/**
 * Decide whether this browser should forward THIS transcript, and under whose
 * name.
 *
 * ── WHY THIS IS NO LONGER "ONLY MY OWN SPEECH" ──────────────────────────────
 * It used to be `transcript.uid !== selfUid -> skip`, because a browser was
 * said to know exactly one role for certain: its own. That was the right rule
 * when each participant ran their own console and every console forwarded its
 * own line.
 *
 * It stopped being the right rule the moment Echo began subscribing to `["*"]`.
 * The toolkit hands EVERY speaker's finished turn to EVERY console on the RTC
 * data stream, so one console can now record the whole room — which is what
 * lets two colleagues join the bridge from any Agora client, with no console,
 * no tunnel and no per-person setup, and still be minuted correctly.
 *
 * THE ORIGINAL DANGER IS REAL AND IS HANDLED, NOT DISCARDED. Forwarding
 * someone else's words under OUR role is worse than not forwarding them: §6.2
 * Rule 1 catches an unsourced claim and nothing downstream catches a
 * MIS-sourced one. So attribution no longer comes from "whose browser is
 * this" — it comes from the Roster, which is the only component that has ever
 * known uid → role. A uid the Roster does not know is skipped outright rather
 * than guessed at.
 *
 * DUPLICATES ARE HANDLED SERVER-SIDE. If two consoles are open they will both
 * forward the same turn, but `messageId` is `uid:turn_id` — identical in both
 * browsers, because it comes from Agora — and the Slow Loop's window rejects a
 * message id it has already accepted. Two consoles cost one wasted request,
 * not a doubled claim.
 *
 * Pure and exported so the multi-speaker case can be tested without three
 * machines on a channel — precisely the configuration this rule exists for and
 * the one that cannot be exercised on one laptop.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function forwardDecision(
  transcript: AgoraTranscript,
  resolveRole: RoleResolver,
  agentUid = 9000,
): ForwardDecision {
  // FIRST, always. An operator reading "skip:unknown-uid" against uid 9000
  // would go hunting for a Roster bug that does not exist.
  if (isAgentTranscript(transcript, agentUid)) return "skip:agent";
  if (!transcript.isFinal) return "skip:partial";
  if (!resolveRole(transcript.uid)) return "skip:unknown-uid";
  return "forward";
}
