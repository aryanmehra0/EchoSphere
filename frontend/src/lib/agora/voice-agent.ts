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
    case "idle":
    case "ready":
    case "connected":
    case "silent":
      return "listening";
    case "thinking":
    case "processing":
      return "thinking";
    case "speaking":
      return "speaking";
    /*
      ── UNKNOWN IS NOT OFFLINE ────────────────────────────────────────────
      `default: return "offline"` was reported live as Echo showing
      "Offline — Not attached to the bridge" while Agora's own status
      endpoint said RUNNING for that exact agent id, and the backend was
      still holding the registration.

      The agent was fine. The console was mapping any status string it did
      not recognise — a transient one between turns, a value Agora added, an
      empty frame — onto the one badge that means "this is dead".

      That reads as a broken bridge and invites a restart of something that
      is working, which is the most expensive kind of wrong status. Only an
      EXPLICIT terminal signal marks Echo offline now; anything unrecognised
      is treated as attached-but-quiet, which is the truthful reading of "we
      have a live agent and no idea what it is doing this instant".

      `stop()` and `/agent/unregister` set offline deliberately, so a real
      departure still shows.
    */
    case "offline":
    case "disconnected":
    case "stopped":
    case "failed":
      return "offline";
    default:
      return "listening";
  }
}

export class VoiceAgent {
  private ai: AgoraVoiceAI | null = null;

  /*
    Session identity, held here because `drain()` receives only the toolkit's
    items and cannot be handed them per call.

    `selfUid` is used for the silence watchdog's diagnostic message and to
    remember which uid this tab joined as. It is deliberately NOT used to
    attribute a turn any more: the toolkit stamps `uid: "0"` on every user
    transcription, so resolving that sentinel to self relabelled OTHER
    people's speech as this browser's. An unattributable turn is dropped
    instead — see `emit`.

    `selfRole` is a FALLBACK ONLY. Attribution comes from the Roster, because
    Echo subscribes to `["*"]` and this console minutes the whole room -
    labelling another person's sentence with our own role is exactly the
    misattribution the stream_id fix exists to prevent.
  */
  private selfUid = 0;
  private selfRole: ParticipantRole | null = null;

  /**
   * Turns already handed to the Slow Loop, keyed `uid:turn_id`.
   *
   * The toolkit re-emits the full array on every update, so without this the
   * same sentence would be forwarded on every keystroke of the recogniser and
   * extraction would see one utterance a dozen times.
   */
  private readonly delivered = new Set<string>();

  /**
   * Cap on `delivered`, because it is otherwise append-only.
   *
   * Every finished turn adds a key and nothing removes one until `stop()`. A
   * bridge that runs for hours with three people talking accumulates keys
   * without limit — a slow leak in the one tab nobody reloads, which is
   * exactly the tab that has to survive the whole incident.
   *
   * Turn ids only ever move forward, so a key old enough to fall out of this
   * window can never be re-emitted; trimming the oldest is safe. 5000 is far
   * beyond any real burst while staying trivial in memory.
   */
  private static readonly MAX_DELIVERED = 5000;

  /** Record a delivered turn, trimming the oldest keys past the cap. */
  private markDelivered(key: string): void {
    // `this.delivered.add`, NOT `this.markDelivered` — a blanket rename of the
    // call sites rewrote this line too and made the method call itself, so
    // every finished turn died in "Maximum call stack size exceeded" before it
    // could be forwarded. Nothing reached the Slow Loop and the transcript
    // panel stayed empty, with the only evidence a stack trace in DevTools.
    this.delivered.add(key);
    if (this.delivered.size <= VoiceAgent.MAX_DELIVERED) return;
    // Set preserves insertion order, so the first N are the oldest.
    const excess = this.delivered.size - VoiceAgent.MAX_DELIVERED;
    let removed = 0;
    for (const old of this.delivered) {
      this.delivered.delete(old);
      if (++removed >= excess) break;
    }
  }

  /**
   * Turns seen at END but not yet forwarded, with the longest text so far.
   *
   * ── WHY A TURN AT "END" IS NOT FINISHED ─────────────────────────────────
   * `TurnStatus.END` is not the last word on a turn. The toolkit re-emits the
   * same turn_id at END repeatedly while the recogniser keeps finalising it,
   * and the text GROWS between emissions:
   *
   *     update 1: [9000#2/1: "Echo is on the bridge."]
   *     update 2: [9000#2/1: "Echo is on the bridge.I am listening,"]
   *     update 3: [9000#2/1: "Echo is on the bridge.I am listening,but"]
   *
   * Forwarding on the first END and marking the turn delivered therefore
   * captured the SHORTEST fragment and dropped every later, fuller version as
   * a duplicate — which is why the transcript panel showed a few words instead
   * of the sentence that was actually spoken.
   *
   * So a turn is held here until its text stops growing, then forwarded once.
   * The Slow Loop still receives each utterance exactly once (§4.4), it just
   * receives the whole one.
   */
  private readonly settling = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * How long a turn must stay unchanged before it counts as final.
   *
   * Long enough to outlast the recogniser's own finalisation (observed at a
   * few hundred ms between END emissions), short enough that the Ledger is
   * not visibly behind the room.
   *
   * ── THIS MUST EXCEED THE AGENT'S end-of-speech WINDOW ───────────────────
   * `agora_agent.py` sets `silence_duration_ms` — how long Agora waits before
   * declaring a turn over. While that window is open the recogniser is STILL
   * growing the text, so a settle shorter than it forwards a fragment and
   * then marks the turn `delivered` FOREVER. Every fuller version that
   * arrives afterwards is discarded as a duplicate.
   *
   * That is the reported defect, twice over:
   *
   *     spoken: "please note that the database is down"
   *     got:    "Please note that that"
   *
   * At SETTLE_MS 900 against silence 1500 the client gave up 600ms before
   * Agora had even finished the turn, so the trailing words could never be
   * accepted — and raising `silence_duration_ms` to fix the earlier
   * truncation made this race WORSE rather than better. Two settings in two
   * languages, each individually defensible, wrong as a pair.
   *
   * 2200 = 1500 (silence) + 700 of headroom for the END re-emissions that
   * follow it. Keep this comfortably above whatever `silence_duration_ms`
   * becomes; if that changes, this changes with it.
   */
  private static readonly SETTLE_MS = 2200;

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
        this.drain(items as ToolkitItem[]);
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
      this.selfUid = selfUid;
      this.selfRole = role;
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
  private drain(items: ToolkitItem[]): void {
    for (const item of items) {
      /*
        ── IN_PROGRESS TEXT IS NOT DISPOSABLE ────────────────────────────────
        This skipped every non-END item, and that threw away words.

        The recogniser streams a turn as IN_PROGRESS and the text grows with
        each update. The END that follows is NOT guaranteed to carry the
        longest version — it can arrive as a shorter re-segmentation, and an
        INTERRUPTED turn (someone talked over someone else, which is normal on
        a three-person bridge) may never reach END at all. Either way the
        fuller IN_PROGRESS reading had already been discarded, so the panel
        showed a fragment of what was said.

        Every status is now recorded; `settling` keeps the longest text seen
        for the turn and forwards once it stops changing. INTERRUPTED is
        treated as final immediately, because nothing more is coming.
      */
      if (
        item.status !== TurnStatus.END &&
        item.status !== TurnStatus.IN_PROGRESS &&
        item.status !== TurnStatus.INTERRUPTED
      ) {
        continue;
      }

      /*
        Keyed on `stream_id`, NOT `uid`.

        `uid` is "0" for every human turn (see the resolution below), so with
        two people in the room a matching turn_id would collide and one
        speaker's sentence would be silently dropped as an already-delivered
        duplicate. `stream_id` is per-speaker, which is exactly what a
        deduplication key needs to be.
      */
      const key = `${item.stream_id}:${item.uid}:${item.turn_id}`;
      if (this.delivered.has(key)) continue;

      const text = (item.text ?? "").trim();
      if (!text) continue;

      /*
        HOLD, DO NOT FORWARD YET. See `settling` above: END repeats while the
        text is still growing, so the first END carries a fragment. Restart the
        timer whenever the text changes; forward when it has stopped changing.
      */
      const pending = this.settling.get(key);
      /*
        ── THE RECOGNISER ALSO SHRINKS A TURN, NOT ONLY GROWS IT ────────────
        Observed live on one turn:

            update 1: [0#3/1: "Hey. You're"]
            update 2: [0#3/1: "Wow."]

        Deepgram revised its own hypothesis and the text got SHORTER. Taking
        whatever arrived last therefore threw away the longer reading, which
        loses words exactly like the truncation this settling was added to fix.

        So keep the LONGEST text seen for a turn, and let any change — longer
        or shorter — restart the settle timer, because a revision means the
        recogniser is still working on it.
      */
      if (pending) {
        if (pending.text === text) continue; // unchanged — let the timer run
        clearTimeout(pending.timer);
        if (text.length < pending.text.length) {
          // A shorter revision: keep the fuller text, but wait again in case
          // the recogniser is mid-correction.
          const timer = setTimeout(() => {
            const settled = this.settling.get(key);
            this.settling.delete(key);
            if (!settled) return;
            this.markDelivered(key);
            this.emit(item, settled.text);
          }, VoiceAgent.SETTLE_MS);
          this.settling.set(key, { text: pending.text, timer });
          continue;
        }
      }

      /*
        An INTERRUPTED turn is over — the speaker was cut off and no further
        update is coming for it. Waiting out the settle window would only
        delay it, and on a three-person bridge people interrupt constantly.
      */
      if (item.status === TurnStatus.INTERRUPTED) {
        const best = pending && pending.text.length > text.length ? pending.text : text;
        this.settling.delete(key);
        this.markDelivered(key);
        this.emit(item, best);
        continue;
      }

      const timer = setTimeout(() => {
        const settled = this.settling.get(key);
        this.settling.delete(key);
        if (!settled) return;
        this.markDelivered(key);
        this.emit(item, settled.text);
      }, VoiceAgent.SETTLE_MS);

      this.settling.set(key, { text, timer });
    }
  }

  /** Forward one settled turn, attributed to whoever actually spoke it. */
  private emit(item: ToolkitItem, text: string): void {
    /*
      ── `stream_id` IS THE SPEAKER; `uid` IS NOT ────────────────────────────
      The toolkit stamps `uid: "0"` on EVERY user.transcription, not just your
      own — `self_uid` is a module constant and the mapping is unconditional.
      With two humans in the room both consoles therefore relabelled the OTHER
      person's speech as their own and forwarded it under their own name, so
      the Ledger recorded every sentence twice with one copy misattributed.

      `stream_id` survives that relabelling untouched and holds the RTC uid of
      whoever actually spoke.
    */
    /*
      ── NEVER FORWARD AN EMPTY TURN ─────────────────────────────────────────
      `drain` skips empty text on the way in, but that is not sufficient now
      that IN_PROGRESS turns are accepted: a turn can be held with real text
      and then re-emitted empty by the recogniser, and VAD fires on coughs and
      room noise, producing turns whose content never becomes a word.

      Forwarding one publishes a blank line into the transcript panel and a
      sourceless row into the Ledger — a claim attributed to a named human who
      said nothing. That is worse than a missing line, because it is a record
      of something that did not happen.
    */
    if (!text.trim()) return;

    const isAgentTurn = item.metadata?.object === MessageType.AGENT_TRANSCRIPTION;
    const streamUid = Number(item.stream_id);

    /*
      ── WITHOUT `stream_id` WE DO NOT KNOW WHO SPOKE, SO WE SAY NOTHING ─────
      This used to fall back to `selfUid` when `stream_id` was unusable and
      the toolkit had stamped `uid: "0"`. On one console that is harmless —
      the only human present IS self. With three consoles it is the worst
      failure this product can produce.

      The toolkit stamps `uid: "0"` on EVERY human turn, not just your own, so
      the fallback fires for other people's speech too. Each of the three
      browsers would then relabel the other two speakers as itself and forward
      it under its own role — and because `messageId` is keyed on
      `resolvedUid`, the three copies get three DIFFERENT ids and none of them
      dedupe. One sentence becomes three claims attributed to three wrong
      people.

      A MIS-SOURCED claim is worse than a missing one, and this codebase
      already says so twice: §6.2 Rule 1 catches an unsourced claim and
      nothing downstream catches a wrongly-sourced one. `forwardDecision`
      already drops uids the Roster cannot name, on exactly this reasoning.

      So an unattributable turn is DROPPED, loudly. Losing one line to a
      malformed frame is recoverable; a confident false attribution in the
      incident record is not.

      Agent turns are exempt: `item.uid` is the agent's own 9000-series uid
      and is reliable there, and `isAgentTranscript` filters them out anyway.
    */
    if (!isAgentTurn && !(Number.isFinite(streamUid) && streamUid > 0)) {
      const fallbackUid = Number(item.uid);
      if (!Number.isFinite(fallbackUid) || fallbackUid <= 0) {
        console.warn(
          "[voice-agent] dropped an unattributable turn — no usable stream_id",
          { uid: item.uid, stream_id: item.stream_id, turn_id: item.turn_id },
        );
        return;
      }
    }

    const resolvedUid = isAgentTurn
      ? Number(item.uid)
      : Number.isFinite(streamUid) && streamUid > 0
        ? streamUid
        : Number(item.uid);

    const transcript: AgoraTranscript = {
      uid: resolvedUid,
      text,
      isFinal: true,
      /*
        ── THE ID MUST BE UNIQUE ACROSS SPEAKERS, NOT JUST WITHIN ONE ───────
        The Slow Loop's `TurnWindow.add` dedupes on `message_id` ALONE — it
        never looks at the uid — and drops any repeat as an already-seen
        utterance.

        `turn_id` is numbered per speaker and restarts at 1 for each of them,
        so `${stream_id}:${turn_id}` still collided the moment two people were
        talking: DevOps turn 3 and the DBA's turn 3 produced the same id under
        different stream_ids only if stream_id differed — and when the toolkit
        reports the same stream for a relabelled turn, the second speaker's
        sentence vanished into "dropped duplicate transcript" with nothing on
        screen to say so.

        `resolvedUid` is the speaker the Ledger will attribute this to, so it
        is exactly the right thing to key on. Including the channel-scoped uid
        makes the id unique across the whole bridge.
      */
      messageId: `${resolvedUid}:${item.stream_id}:${item.turn_id}`,
      object: isAgentTurn ? "assistant.transcription" : "",
    };

    /*
      ── ATTRIBUTION COMES FROM THE ROSTER, NOT FROM WHOSE BROWSER THIS IS ───
      This used to be `forwardDecision(transcript, selfUid)` - forward only my
      own speech - which was right while each participant ran their own console
      and forwarded their own line. It stopped being right the moment Echo
      began subscribing to `["*"]`: this console now hears the whole room, and
      a uid the Roster cannot name must be DROPPED rather than filed under
      whoever happens to be sitting here.
    */
    if (forwardDecision(transcript, this.events.resolveRole) !== "forward") return;

    // Non-null: `forwardDecision` returns "skip:unknown-uid" otherwise. The
    // local role is a fallback for the agent's own turns, which the Roster
    // does not name.
    const speaker = this.events.resolveRole(transcript.uid) ?? this.selfRole;
    if (!speaker) return;

    this.forwarded += 1;
    console.info(
      `[voice-agent] forwarded uid=${transcript.uid} "${transcript.text.slice(0, 60)}"`,
    );
    this.events.onUtterance(transcript, speaker);
  }

  async stop(): Promise<void> {
    const ai = this.ai;
    this.ai = null;
    this.delivered.clear();
    // Pending turns die with the session — firing them after a leave would
    // forward speech into a bridge this console is no longer part of.
    for (const { timer } of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
    if (!ai) return;
    try {
      ai.unsubscribe();
      ai.destroy();
    } catch {
      // Already torn down with the RTC client.
    }
  }
}
