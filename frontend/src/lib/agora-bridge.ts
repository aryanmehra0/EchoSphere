"use client";

import type {
  IAgoraRTCClient,
  ILocalAudioTrack,
  IRemoteAudioTrack,
} from "agora-rtc-sdk-ng";
import type { RTMClient, RTMConfig } from "agora-rtm-sdk";

import type { AgoraTranscript, ForwardDecision } from "./agora-transcript";
import { forwardTranscriptToSlowLoop } from "./delta-socket";
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
  private channel: string | null = null;
  private credentials: BridgeCredentials | null = null;

  /**
   * Why transcripts were not forwarded, by reason.
   *
   * Exposed because the failure this guards against is SILENT: if Agora stops
   * echoing a speaker their own transcript, every frame reads "skip:not-mine"
   * and the dashboard simply stops filling. A count makes that a five-second
   * diagnosis rather than a mystery.
   */
  readonly skipped: Partial<Record<ForwardDecision, number>> = {};
  forwarded = 0;


  /**
   * The Conversational AI transcript layer (Agora's official toolkit).
   * Owns the RTC data-stream feed; this class owns the media session.
   */
  private readonly voice: VoiceAgent;

  constructor(private readonly events: AgoraBridgeEvents) {
    this.voice = new VoiceAgent({
      onUtterance: (transcript, role) => void this.forwardTranscript(transcript, role),
      onTranscriptView: () => {},
      onAgentState: (state) => this.events.onAgentState(state),
      onError: (detail) => this.events.onError(detail),
    });
  }

  async join(channel: string, credentials: BridgeCredentials): Promise<void> {
    await this.leave();

    const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
    const AgoraRTM = (await import("agora-rtm-sdk")).default;
    const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    this.client = client;
    this.channel = channel;
    this.credentials = credentials;
    this.events.onAgentState("joining");

    client.on("user-published", async (user, mediaType) => {
      if (mediaType !== "audio") return;
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
        this.events.onError(`Could not subscribe to remote audio: ${message(error)}`);
      }
    });

    client.on("user-left", (user) => {
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
      this.mic = await AgoraRTC.createMicrophoneAudioTrack();
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
        await rtm.logout();
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
      // Non-fatal by design. Transcripts do not come from here.
      this.rtm = null;
      console.warn("[agora rtm] unavailable — continuing without it", error);
    }

    await this.voice.start(this.client!, credentials.uid, credentials.role, rtmClient);
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
