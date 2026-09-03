/**
 * Normalize the transcript envelopes emitted by Agora Conversational AI.
 *
 * Agora has used several field names across agent versions. Keeping this
 * parser pure makes that vendor boundary executable and keeps the reducer's
 * transcript contract stable.
 */
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
  | "skip:not-mine";

/**
 * Decide whether THIS browser should forward THIS transcript.
 *
 * ── THE RULE, AND WHY IT MATTERS ────────────────────────────────────────────
 * RTM broadcasts every transcript to every subscriber, but a browser knows
 * exactly one role for certain: its own. So each participant forwards only
 * their own speech.
 *
 * Forwarding someone else's would label it with OUR role — on the two-machine
 * setup §18 requires, DevOps's console would file Support's sentences as
 * DevOps's own. A MIS-sourced claim is worse than an unsourced one, because
 * §6.2 Rule 1 catches the second and nothing downstream can catch the first.
 * It would also mean two browsers forwarding one utterance, so every sentence
 * gets extracted twice.
 *
 * Pure and exported so it can be tested without two machines on a channel —
 * which is precisely the configuration this rule exists for and the one that
 * cannot be exercised on a single laptop.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function forwardDecision(
  transcript: AgoraTranscript,
  selfUid: number,
  agentUid = 9000,
): ForwardDecision {
  if (isAgentTranscript(transcript, agentUid)) return "skip:agent";
  if (!transcript.isFinal) return "skip:partial";
  if (transcript.uid !== selfUid) return "skip:not-mine";
  return "forward";
}
