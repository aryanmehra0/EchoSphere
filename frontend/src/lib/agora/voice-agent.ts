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

  /**
   * Fires if the data stream stays silent after we have subscribed.
   *
   * ── WHY A TIMER AND NOT JUST THE CATCH BLOCK ────────────────────────────
   * `start()` already reports the LOUD failure — subscribe threw, and the
   * operator is told. The expensive failure is the quiet one: subscribe
   * succeeds, `TRANSCRIPT_UPDATED` never fires, and the transcript panel sits
   * on "No speech captured" forever. That is indistinguishable from nobody
   * having spoken, so nobody reports it as a fault; it reads as the product
   * being broken in some unspecified way.
   *
   * This has now happened twice from different causes (wrong transport, then a
   * dead agent being reused), and both times it was diagnosed by reading
   * Agora's REST history from a shell rather than by looking at the console.
   * A subscribed stream that has carried nothing for this long is worth saying
   * out loud.
   */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private armSilenceWatchdog(channel: string, selfUid: number): void {
    if (this.silenceTimer !== null) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.updates > 0) return;
      this.events.onError(
        `NO TRANSCRIPT DATA — subscribed to "${channel}" as uid ${selfUid}, ` +
          "but the RTC data stream has carried nothing. Check that the agent " +
          "is RUNNING and joined this same channel.",
      );
    }, 45_000);
  }

  /** Stop the watchdog — called on the first update and on teardown. */
  private disarmSilenceWatchdog(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  constructor(private readonly events: VoiceAgentEvents) {}

  async start(
    rtcClient: IAgoraRTCClient,
    channel: string,
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
        // The stream is alive; the watchdog has nothing to report.
        this.disarmSilenceWatchdog();
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
        this.drain(items as ToolkitItem[], selfUid, role);
      });

      this.ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_uid, event) => {
        this.events.onAgentState(toAgentState(String(event?.state ?? "")));
      });

      this.ai.on(AgoraVoiceAIEvents.AGENT_ERROR, (_uid, error) => {
        this.events.onError(`Agent error: ${String(error?.message ?? error)}`);
      });

      /*
        ── `init()` BINDS NOTHING. THIS LINE IS THE SUBSCRIPTION. ────────────
        This was the whole failure, and it is invisible from the outside.

        `AgoraVoiceAI.init()` only STORES config — it validates the engines,
        stashes them on the singleton and returns. Read `_doInit` in
        `dist/index.mjs`: it assigns `rtcEngine`, `rtmEngine`, `renderMode`
        and returns. It attaches no listener to anything.

        `subscribeMessage(channel)` is what calls `bindRtcEvents()`, which is
        the ONLY place the toolkit does

            rtcEngine.on("stream-message", this._boundHandleRtcStreamMessage)

        and it also starts the render controller that turns those frames into
        TRANSCRIPT_UPDATED. The toolkit's own documented example shows both
        calls, in this order:

            const api = AgoraVoiceAI.init({...});
            api.subscribeMessage('channel-id');

        Without it, `on(TRANSCRIPT_UPDATED, ...)` registers a handler on an
        emitter that nothing will ever emit into. Every symptom follows: the
        agent joins, the mic publishes, Agora transcribes — and the console
        shows zero `[voice-agent] update` lines, because the RTC data stream
        was never being read. No error, no warning, no failed promise. The
        previous fix moved to the right TRANSPORT and then never opened it.
      */
      this.ai.subscribeMessage(channel);
      this.armSilenceWatchdog(channel, selfUid);

      console.info(
        `[voice-agent] subscribed to ${channel} — transcript layer ready for uid ${selfUid}`,
      );
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
  private drain(items: ToolkitItem[], selfUid: number, role: ParticipantRole): void {
    for (const item of items) {
      if (item.status !== TurnStatus.END) continue;

      const key = `${item.uid}:${item.turn_id}`;
      if (this.delivered.has(key)) continue;

      const text = (item.text ?? "").trim();
      if (!text) continue;

      /*
        ── THE TOOLKIT STAMPS YOUR OWN SPEECH AS uid "0" ─────────────────────
        Not your real uid — a hardcoded sentinel meaning "the local user".
        From `dist/index.mjs`:

            var SELF_USER_ID = 0;
            uid: message.object === "user.transcription"
                   ? `${CovSubRenderController.self_uid}`   // always "0"
                   : `${uid}`

        There is no setter for it; `self_uid` is a module constant.

        So every human turn arrived as uid 0, `forwardDecision` compared
        0 !== 1001, returned "skip:not-mine", and dropped it. The agent's own
        turns carried a real uid (9000) and were correctly skipped as
        "skip:agent" — which is why the RTC stream was demonstrably alive
        (TRANSCRIPT_UPDATED fired, text streamed in) while NOTHING ever
        reached the Ledger or the transcript panel.

        The official quickstart does exactly this mapping:
            const nextUid = item.uid === '0' ? localUid : item.uid
        — see `web/src/lib/conversation.ts::normalizeTranscript`.
      */
      const rawUid = String(item.uid);
      const resolvedUid =
        rawUid === "0" && item.metadata?.object !== MessageType.AGENT_TRANSCRIPTION
          ? selfUid
          : Number(item.uid);

      const transcript: AgoraTranscript = {
        uid: resolvedUid,
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

      // The existing per-UID rule still decides: each browser forwards only
      // its OWN speech, and never the agent's. That logic is tested and is
      // what keeps two machines from double-forwarding or mis-attributing.
      if (forwardDecision(transcript, selfUid) !== "forward") continue;

      this.forwarded += 1;
      console.info(
        `[voice-agent] forwarded uid=${transcript.uid} "${transcript.text.slice(0, 60)}"`,
      );
      this.events.onUtterance(transcript, role);
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
