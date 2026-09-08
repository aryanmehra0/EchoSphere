"use client";

import type {
  IAgoraRTCClient,
  ILocalAudioTrack,
  IRemoteAudioTrack,
} from "agora-rtc-sdk-ng";
import type { RTMClient, RTMConfig } from "agora-rtm-sdk";

import type { AgoraTranscript, ForwardDecision } from "./agora-transcript";
import { fetchRoster, forwardTranscriptToSlowLoop } from "./delta-socket";
import { VoiceAgent } from "./agora/voice-agent";
import type { AgentState, ParticipantRole } from "./types";

const AGENT_UID = 9000;

export interface BridgeCredentials {
  appId: string;
  rtcToken: string;
  rtmToken: string;
  uid: number;
  role: ParticipantRole;
}

export interface AgoraBridgeEvents {
  onAgentTrack: (track: IRemoteAudioTrack | null) => void;
  onAgentState: (state: AgentState) => void;
  onError: (message: string) => void;
}

type RTMConstructor = new (
  appId: string,
  userId: string,
  config?: RTMConfig,
) => RTMClient;

/**
 * Browser-only RTC + RTM transport. Incident state still enters through the
 * Slow Loop and the reducer; this object owns disposable media resources only.
 */
export class AgoraBridge {
  private client: IAgoraRTCClient | null = null;
  private mic: ILocalAudioTrack | null = null;
  private rtm: RTMClient | null = null;
  private silenceTimer: number | null = null;

  /**
   * UIDs with a `subscribe` call in flight or already satisfied.
   *
   * ── WHY A SET AND NOT JUST A TRY/CATCH ──────────────────────────────────
   * `user-published` is not a once-per-user event. Agora re-fires it whenever
   * a remote republishes — which Echo does on every reconnect, interrupt and
   * TTS restart — and the handler is `async`, so two firings overlap: the
   * second `subscribe` is issued while the first is still on the wire, and the
   * server rejects the pair with
   *
   *     ERR_SUBSCRIBE_REQUEST_INVALID: Repeat subscribe request (code 2021)
   *
   * Nothing is actually wrong when that happens — the first subscribe
   * succeeds and audio plays — but it throws, so it surfaced as a red console
   * error on a working bridge.
   *
   * Cleared per-uid on `user-unpublished` and `user-left`, and wholesale on
   * `leave()`, so a genuine resubscribe after a republish still goes through.
   */
  private readonly subscribing = new Set<number>();
  private channel: string | null = null;
  private credentials: BridgeCredentials | null = null;

  /**
   * Why transcripts were not forwarded, by reason.
   *
   * Exposed because the failure this guards against is SILENT. A dashboard
   * that stops filling looks identical whichever cause it has, and the counts
   * separate them in five seconds: a pile of "skip:unknown-uid" means the
   * Roster does not know who is speaking, while zero updates of any kind means
   * the RTC data stream itself is quiet and the fault is upstream of us.
   */
  readonly skipped: Partial<Record<ForwardDecision, number>> = {};
  forwarded = 0;


  /**
   * The Conversational AI transcript layer (Agora's official toolkit).
   * Owns the RTC data-stream feed; this class owns the media session.
   */
  private readonly voice: VoiceAgent;

  /**
   * uid → role for everyone on the bridge, refreshed from the Roster.
   *
   * Echo subscribes to `["*"]`, so this console minutes the whole room and
   * needs a name for each speaker. Held as a map rather than looked up per
   * utterance because `resolveRole` sits on the transcript hot path and must
   * be synchronous.
   */
  private readonly roles = new Map<number, ParticipantRole>();

  /** In-flight roster refresh, so a burst of unknown uids makes ONE request. */
  private rosterRefresh: Promise<void> | null = null;

  constructor(private readonly events: AgoraBridgeEvents) {
    this.voice = new VoiceAgent({
      resolveRole: (uid) => this.resolveRole(uid),
      onUtterance: (transcript, role) => void this.forwardTranscript(transcript, role),
      onTranscriptView: () => {},
      onAgentState: (state) => this.events.onAgentState(state),
      onError: (detail) => this.events.onError(detail),
    });
  }

  /**
   * Name a speaker, or refuse to.
   *
   * Falls back to THIS operator's own role for their own uid, so a Roster that
   * cannot be reached costs the other participants' lines but never this
   * console's — the single-machine demo keeps working when the network does
   * not. Any other unknown uid returns null and the turn is dropped: guessing
   * would put one person's words in another's mouth.
   */
  private resolveRole(uid: number): ParticipantRole | null {
    const known = this.roles.get(uid);
    if (known) return known;

    if (this.credentials && uid === this.credentials.uid) {
      return this.credentials.role;
    }

    // Someone spoke before we learned who they are — a late joiner, almost
    // always. Refresh in the background; the next turn resolves.
    void this.refreshRoster();
    return null;
  }

  private async refreshRoster(): Promise<void> {
    const channel = this.channel;
    if (!channel || this.rosterRefresh) return;

    this.rosterRefresh = (async () => {
      const next = await fetchRoster(channel);
      // Empty means the fetch failed. Keeping the previous map is strictly
      // better than clearing it and going deaf to everyone.
      if (next.size > 0) {
        this.roles.clear();
        for (const [uid, role] of next) this.roles.set(uid, role);
      }
    })();

    try {
      await this.rosterRefresh;
    } finally {
      this.rosterRefresh = null;
    }
  }

  async join(channel: string, credentials: BridgeCredentials): Promise<void> {
    await this.leave();

    const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
    const AgoraRTM = (await import("agora-rtm-sdk")).default;

    /*
      ── REQUIRED BY THE TRANSCRIPT TOOLKIT, AND WE NEVER SET IT ─────────────
      The official quickstart calls this before initialising the toolkit:

          setParameter("ENABLE_AUDIO_PTS", true);

      and `bindRtcEvents()` subscribes to `audio-pts` alongside
      `stream-message`. PTS is how the render controller aligns transcript
      chunks to the audio timeline; without it the controller has no clock to
      order turns against and never emits TRANSCRIPT_UPDATED.

      That is the whole symptom: subscribe succeeds, the agent converses
      perfectly (Agora's REST history proves it), and the console's transcript
      panel stays on "No speech captured" with no error anywhere.

      Wrapped because it is a private-ish knob — a version that no longer
      recognises it must not take the join down with it.
    */
    try {
      // Named export from the ESM entry, exactly as the quickstart imports it
      // (`import { setParameter } from "agora-rtc-sdk-ng/esm"`). It is not a
      // method on the default AgoraRTC object.
      const { setParameter } = await import("agora-rtc-sdk-ng/esm");
      setParameter("ENABLE_AUDIO_PTS", true);
      console.info("[agora rtc] audio PTS enabled — transcript timing available");
    } catch (error) {
      console.warn("[agora rtc] could not enable audio PTS", error);
    }

    const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    this.client = client;
    this.channel = channel;
    this.credentials = credentials;
    this.events.onAgentState("joining");

    client.on("user-published", async (user, mediaType) => {
      if (mediaType !== "audio") return;
      // A new voice on the bridge. Learn their role BEFORE they finish their
      // first sentence, or that sentence is dropped as unattributable — which
      // is safe but is still a lost line from a colleague who just joined.
      if (!this.roles.has(Number(user.uid))) void this.refreshRoster();

      // Already subscribed, or a subscribe is on the wire. A second call now
      // is the "Repeat subscribe request" the server rejects.
      const uid = Number(user.uid);
      if (this.subscribing.has(uid)) return;
      this.subscribing.add(uid);

      try {
        await client.subscribe(user, "audio");
        const track = user.audioTrack;
        if (!track) return;
        track.play();
        if (Number(user.uid) === AGENT_UID) {
          this.events.onAgentTrack(track);
          this.events.onAgentState("listening");
        }
      } catch (error) {
        /*
          ── A LOST RACE IS NOT A FAULT ──────────────────────────────────────
          `user-published` and `subscribe` are two round trips apart, and the
          publisher can be gone in between. Agora then throws

              UNEXPECTED_ERROR: can not find remote track in user object

          which is not unexpected at all here: Echo is torn down and recreated
          constantly (a reset, a re-invite, an idle timeout), so the console
          routinely learns about a track that no longer exists by the time it
          asks for it. `user-left` fires immediately after and the UI settles
          correctly on its own.

          Reporting it through `onError` was actively harmful once that hook
          started raising the degradation banner: a transient race put
          "NO VOICE" on screen over a bridge that was working, and the banner
          does not clear itself. So this one is logged and swallowed, and only
          genuine subscribe failures are surfaced.
        */
        // The subscribe did not take, so this uid must be eligible again —
        // otherwise a track that republishes later would never be picked up.
        this.subscribing.delete(uid);

        const detail = message(error);
        if (/can not find remote track|UNEXPECTED_ERROR|Repeat subscribe request/i.test(detail)) {
          console.info(
            `[agora rtc] subscribe to uid ${user.uid} did not take (${detail.slice(0, 80)}) — ignoring`,
          );
          return;
        }
        this.events.onError(`Could not subscribe to remote audio: ${detail}`);
      }
    });

    // A republish must be resubscribable, so the guard is released the moment
    // the track goes away rather than being held until leave().
    client.on("user-unpublished", (user, mediaType) => {
      if (mediaType !== "audio") return;
      this.subscribing.delete(Number(user.uid));
    });

    client.on("user-left", (user) => {
      this.subscribing.delete(Number(user.uid));
      if (Number(user.uid) === AGENT_UID) this.clearAgentTrack();
    });

    client.enableAudioVolumeIndicator();
    client.on("volume-indicator", (volumes) => {
      const agent = volumes.find((volume) => Number(volume.uid) === AGENT_UID);
      if (!agent || agent.level < 2) return;
      this.events.onAgentState("speaking");
      if (this.silenceTimer !== null) window.clearTimeout(this.silenceTimer);
      this.silenceTimer = window.setTimeout(() => {
        this.events.onAgentState("listening");
      }, 700);
    });

    try {
      await client.join(credentials.appId, channel, credentials.rtcToken, credentials.uid);
      /*
        ── WORK WITH WHATEVER MICROPHONE THE PERSON HAS ────────────────────
        This was a bare `createMicrophoneAudioTrack()`, which takes the
        browser's default device with no processing hints, and the docs
        compensated by telling people to wear headsets.

        That guidance existed for a real reason: on open speakers each
        laptop's mic picks up the OTHER participants' audio and Echo's own
        replies, so the same sentence is transcribed under two different
        UIDs and the Ledger attributes one person's words to another. But
        "buy a headset" is a requirement placed on the room, not a property
        of the product, and the browser can do most of the work instead.

        So the three WebRTC processing flags are asked for explicitly:

          AEC — cancels what our own speakers are playing, which is both
                Echo's TTS and the other participants. This is the one that
                makes speakerphone usable at all.
          ANS — suppresses steady room noise (fans, air conditioning) that
                would otherwise trip VAD and produce empty turns.
          AGC — levels a quiet or distant voice, so someone leaning back
                from a laptop mic is still transcribed.

        These are HINTS, not guarantees: a browser or OS may ignore any of
        them, and no amount of AEC fully separates two people sitting a
        metre apart with both mics open. Headsets are still BETTER. They are
        no longer presented as required, and the attribution safety net does
        not depend on them — an unattributable turn is dropped rather than
        guessed (see `voice-agent.ts`).
      */
      this.mic = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true,
        ANS: true,
        AGC: true,
      });
      await client.publish([this.mic]);

      /*
        Exposed for diagnostics only, and it earns its place.

        "No transcripts" is ambiguous between a deaf product and a silent
        microphone, and telling those apart cost days. `getVolumeLevel()` on
        the local track answers it in one line: zero means nothing was ever
        transmitted, and no server-side configuration would have helped.

        Read by `npm run demo speech` and the audio harness. Never read by
        application code — incident state does not come from here.
      */
      (window as unknown as { __echoLocalTrack?: unknown }).__echoLocalTrack = this.mic;
      await this.startForwarding(AgoraRTM.RTM, channel, credentials);
      this.events.onAgentState("listening");
    } catch (error) {
      await this.leave();
      throw error;
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.mic?.setMuted(muted);
  }

  async leave(): Promise<void> {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.clearAgentTrack();
    // The next bridge may be a different channel with different people.
    this.roles.clear();
    // And without this a rejoin would see every uid as "already subscribing"
    // and silently never subscribe to anyone.
    this.subscribing.clear();
    await this.voice.stop();

    const mic = this.mic;
    this.mic = null;
    if (mic) {
      mic.stop();
      mic.close();
    }

    const rtm = this.rtm;
    this.rtm = null;
    if (rtm) {
      try {
        /*
          ── AWAITED, AND THEN GIVEN A BEAT ──────────────────────────────────
          `logout()` resolves before the SDK has released its instance slot,
          so a join that begins immediately afterwards constructs a SECOND RTM
          client for the same uid and Agora warns:

              <RTM> Ins id is 2 ... avoid mutual kick issues

          The two instances then kick each other, and because the transcript
          feed arrives over RTM (`data_channel: "rtm"`) the loser goes silent
          for the rest of the session — the "it stops listening to the other
          person" that never recovered on its own.

          The real guard is `joining` in `incident-store.tsx`, which stops two
          joins overlapping at all. This is the belt to that braces: a short
          settle so a legitimate rejoin does not race the SDK's own teardown.
        */
        await rtm.logout();
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch {
        // A half-open RTM connection is already being discarded.
      }
    }

    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.leave();
      } catch {
        // Cleanup must be best-effort so a new join is never blocked.
      }
    }
    this.channel = null;
    this.credentials = null;
    this.events.onAgentState("offline");
  }

  private async startForwarding(
    RTM: RTMConstructor,
    channel: string,
    credentials: BridgeCredentials,
  ): Promise<void> {
    /*
      ── RTM IS OPTIONAL HERE, AND THAT WAS THE WHOLE BUG ────────────────────
      This method used to subscribe to an RTM message channel and parse
      transcript frames by hand. It received nothing, ever — proven by feeding
      Chrome a real WAV as a microphone and watching sixty seconds of speech
      produce zero frames while the dashboard filled happily from injected
      text.

      Conversational AI transcripts travel on the RTC DATA STREAM, not RTM.
      Agora's own toolkit says so plainly: "when absent, the toolkit operates
      on RTC stream-messages only." RTM adds agent state, interrupts and text
      injection on top — useful, but not the transcript feed.

      So the RTM client is now built for those extras and passed to the
      toolkit, and losing it degrades the experience rather than silencing it.
    */
    let rtmClient: RTMClient | undefined;

    try {
      const rtm = new RTM(credentials.appId, String(credentials.uid));
      this.rtm = rtm;
      await rtm.login({ token: credentials.rtmToken });
      await rtm.subscribe(channel);
      rtmClient = rtm;
      console.info(`[agora rtm] subscribed to ${channel} as uid ${credentials.uid}`);
    } catch (error) {
      /*
        ── NOT "NON-FATAL" ANY MORE, BECAUSE THE AGENT IS STARTED WITH
           `data_channel: "rtm"` ────────────────────────────────────────────
        The old comment here said "Transcripts do not come from here." That
        was true of the hand-rolled RTM listener this replaced, and it is
        false of the current configuration: `voice_agent.py` starts every
        agent with `parameters={"data_channel": "rtm", ...}`, exactly as the
        quickstart does, so Agora publishes the transcript feed over RTM and
        the toolkit reads it through `rtmConfig`.

        Losing RTM therefore loses every transcript — silently, because the
        toolkit falls back to RTC stream-messages that Agora is not sending.
        Say so instead of swallowing it.
      */
      this.rtm = null;
      console.warn("[agora rtm] unavailable — transcripts will not arrive", error);
      this.events.onError(
        `NO TRANSCRIPTS — RTM is unavailable, and the agent publishes its ` +
          `transcript feed over RTM: ${message(error)}`,
      );
    }

    // Learn the room before the transcript layer starts handing us turns.
    // Awaited: it is one same-origin request, and starting deaf to everyone
    // but ourselves would drop the opening exchange of the incident.
    await this.refreshRoster();

    await this.voice.start(this.client!, channel, credentials.uid, credentials.role, rtmClient);
  }


  private async forwardTranscript(
    transcript: AgoraTranscript,
    role: ParticipantRole,
  ): Promise<void> {
    try {
      await forwardTranscriptToSlowLoop(transcript, role);
      this.forwarded += 1;
    } catch (error) {
      this.events.onError(`Transcript forwarding paused: ${message(error)}`);
    }
  }

  private clearAgentTrack(): void {
    this.events.onAgentTrack(null);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
