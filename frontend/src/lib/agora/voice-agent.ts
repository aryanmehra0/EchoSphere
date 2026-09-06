"use client";

import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  MessageType,
  TranscriptHelperMode,
  TurnStatus,
  type AgentTranscription,
  type TranscriptHelperItem,
  type UserTranscription,
} from "agora-agent-client-toolkit";
import type { IAgoraRTCClient } from "agora-rtc-sdk-ng";

import { forwardDecision, type AgoraTranscript } from "../agora-transcript";
import type { AgentState, ParticipantRole } from "../types";

/**
 * The Conversational AI transcript layer — Agora's official toolkit, adapted
 * to this product's domain.
 *
 * ── WHY THIS REPLACED A HAND-ROLLED RTM LISTENER ───────────────────────────
 * The console used to subscribe to an RTM message channel and parse frames
 * itself. It received nothing, ever. A test that fed Chrome a real WAV as a
 * microphone confirmed it: RTM logged in, `subscribe` resolved, sixty seconds
 * of speech played into the channel, and ZERO frames arrived. The dashboard
 * filled perfectly from injected text and was completely deaf to actual
 * speech — with no error anywhere to say so.
 *
 * The reason is one line in the toolkit's own contract:
 *
 *     "When absent, the toolkit operates on RTC stream-messages only."
 *
 * Conversational AI transcripts travel on the RTC DATA STREAM. RTM carries
 * agent state, interrupts and text injection — not the transcript feed. We
 * were listening on the wrong transport, and no amount of RTM configuration
 * was ever going to fix it.
 *
 * ── WHY A WRAPPER AND NOT THE TOOLKIT DIRECTLY IN A COMPONENT ──────────────
 * The toolkit emits the WHOLE transcript array on every update, including
 * turns still in progress. This product's Slow Loop must receive each finished
 * utterance exactly once and never a partial: §4.4 batches on turn boundaries,
 * and a re-sent turn would double every claim in the Ledger. Turning a
 * cumulative view into an at-most-once event stream is real logic, and it
 * belongs here rather than in a React component.
 */

/** What the console needs back from a transcript update. */
export interface VoiceAgentEvents {
  /**
   * uid → role, from the Roster.
   *
   * Echo subscribes to every participant, so this console sees the whole
   * room's turns and must name each speaker from the Roster rather than assume
   * they are all this browser's operator. Returning `null` for an unknown uid
   * is what makes "drop it" the default instead of "guess".
   */
  resolveRole: (uid: number) => ParticipantRole | null;
  /** One COMPLETED utterance, exactly once, already role-attributed. */
  onUtterance: (transcript: AgoraTranscript, role: ParticipantRole) => void;
  /** Live transcript for display, including turns still in progress. */
  onTranscriptView: (items: TranscriptHelperItem<unknown>[]) => void;
  onAgentState: (state: AgentState) => void;
  onError: (detail: string) => void;
}

type ToolkitItem = TranscriptHelperItem<
  Partial<UserTranscription | AgentTranscription>
>;

/**
 * Agora's agent states are richer than this console's four. Collapsed rather
 * than widened: the UI shows an operator whether Echo is listening, thinking
 * or talking, and inventing more states than the dashboard can render would
 * only produce a badge nobody has designed.
 */
function toAgentState(raw: string | undefined): AgentState {
  switch ((raw ?? "").toLowerCase()) {
    case "listening":
      return "listening";
    case "thinking":
    case "processing":
      return "thinking";
    case "speaking":
      return "speaking";
    default:
      return "offline";
  }
}

export class VoiceAgent {
  private ai: AgoraVoiceAI | null = null;

  /**
   * Turns already handed to the Slow Loop, keyed `uid:turn_id`.
   *
   * The toolkit re-emits the full array on every update, so without this the
   * same sentence would be forwarded on every keystroke of the recogniser and
   * extraction would see one utterance a dozen times.
   */
  private readonly delivered = new Set<string>();

  /** Diagnostics. Zero updates means the RTC data stream is silent. */
  updates = 0;
  forwarded = 0;

  constructor(private readonly events: VoiceAgentEvents) {}

  async start(
    rtcClient: IAgoraRTCClient,
    selfUid: number,
    role: ParticipantRole,
    rtmClient?: unknown,
  ): Promise<void> {
    try {
      this.ai = await AgoraVoiceAI.init({
        // The RTC client is mandatory — it is where transcripts actually
        // arrive. RTM is optional and only adds agent-state and interrupt.
        rtcEngine: rtcClient as never,
        ...(rtmClient ? { rtmConfig: { rtmEngine: rtmClient as never } } : {}),
        // TEXT rather than WORD: extraction consumes whole sentences (§4.4),
        // and word-timed updates would multiply the event rate for no gain.
        renderMode: TranscriptHelperMode.TEXT,
        enableLog: false,
      });

      this.ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (items) => {
        this.updates += 1;
        /*
          Logged on every update, not sampled.

          The failure this makes visible is total silence, and silence is
          indistinguishable from "working but nobody spoke" without a counter.
          Knowing whether the RTC data stream carries ANYTHING is the first
          question in every diagnosis here, and it used to take a rebuild to
          answer.
        */
        console.info(
          `[voice-agent] update ${this.updates}: ${items.length} item(s)`,
          items.map((i) => `${i.uid}#${i.turn_id}/${i.status}:${(i.text ?? "").slice(0, 40)}`),
        );
        this.events.onTranscriptView(items as TranscriptHelperItem<unknown>[]);
        this.drain(items as ToolkitItem[]);
      });

      this.ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_uid, event) => {
        this.events.onAgentState(toAgentState(String(event?.state ?? "")));
      });

      this.ai.on(AgoraVoiceAIEvents.AGENT_ERROR, (_uid, error) => {
        this.events.onError(`Agent error: ${String(error?.message ?? error)}`);
      });

      console.info(`[voice-agent] transcript layer ready for uid ${selfUid}`);
    } catch (error) {
      // Losing transcripts costs the incident record, not the call. The
      // operator can still hear and be heard; they are told which capability
      // went rather than left to infer it from an empty dashboard.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("[voice-agent] could not start the transcript layer", error);
      this.events.onError(`NO TRANSCRIPTS — ${detail}`);
      throw error;
    }
  }

  /**
   * Emit each newly-finished utterance exactly once.
   *
   * Only `TurnStatus.END` is forwarded. An IN_PROGRESS turn is a partial
   * sentence, and extraction on half a sentence produces claims nobody made —
   * which is the same failure as inventing one.
   */
  private drain(items: ToolkitItem[]): void {
    for (const item of items) {
      if (item.status !== TurnStatus.END) continue;

      const key = `${item.uid}:${item.turn_id}`;
      if (this.delivered.has(key)) continue;

      const text = (item.text ?? "").trim();
      if (!text) continue;

      const transcript: AgoraTranscript = {
        uid: Number(item.uid),
        text,
        isFinal: true,
        messageId: key,
        // The toolkit tells us directly whether this was the agent talking,
        // which is a stronger signal than the UID convention G2 relies on.
        object: item.metadata?.object === MessageType.AGENT_TRANSCRIPTION
          ? "assistant.transcription"
          : "",
      };

      this.delivered.add(key);

      // Attribution comes from the ROSTER, not from whose browser this is.
      // Echo subscribes to every participant, so this console minutes the
      // whole room — and an utterance whose uid the Roster cannot name is
      // dropped rather than filed under the wrong person.
      const speaker = this.events.resolveRole(transcript.uid);
      if (forwardDecision(transcript, this.events.resolveRole) !== "forward") {
        continue;
      }

      this.forwarded += 1;
      this.events.onUtterance(transcript, speaker as ParticipantRole);
    }
  }

  async stop(): Promise<void> {
    const ai = this.ai;
    this.ai = null;
    this.delivered.clear();
    if (!ai) return;
    try {
      ai.unsubscribe();
      ai.destroy();
    } catch {
      // Already torn down with the RTC client.
    }
  }
}
