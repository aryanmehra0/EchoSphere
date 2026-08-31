"use client";

import type {
  IAgoraRTCClient,
  ILocalAudioTrack,
  IRemoteAudioTrack,
} from "agora-rtc-sdk-ng";
import type { RTMClient, RTMConfig } from "agora-rtm-sdk";

import {
  forwardDecision,
  parseAgoraTranscript,
  type AgoraTranscript,
  type ForwardDecision,
} from "./agora-transcript";
import { forwardTranscriptToSlowLoop } from "./delta-socket";
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

  /** Inbound RTM frames of any kind. Zero means Agora is publishing nothing. */
  rtmFrames = 0;
  /** Frames that arrived but were not recognisable as transcripts. */
  unparsed = 0;

  constructor(private readonly events: AgoraBridgeEvents) {}

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
    const rtm = new RTM(credentials.appId, String(credentials.uid));
    this.rtm = rtm;

    rtm.addEventListener("message", (event) => {
      /*
        EVERY inbound RTM frame is counted, before parsing.

        A live test with real audio produced zero claims, and the existing
        counters could not distinguish the two very different causes: Agora
        publishing nothing at all, versus Agora publishing frames this code
        then discards. Those need opposite fixes, and on a stage you have
        about ten seconds to tell them apart.
      */
      this.rtmFrames += 1;
      console.info(
        `[agora rtm] frame ${this.rtmFrames}:`,
        typeof event.message === "string"
          ? event.message.slice(0, 200)
          : event.message,
      );

      const transcript = parseAgoraTranscript(event.message);
      if (!transcript) {
        this.unparsed += 1;
        return;
      }

      // Each participant forwards only their OWN speech — see forwardDecision.
      const decision = forwardDecision(transcript, credentials.uid);
      if (decision !== "forward") {
        // Logged rather than dropped silently. If Agora ever stops echoing a
        // speaker's own transcript back to them, every frame would read
        // "skip:not-mine" and the Slow Loop would go quiet with no other
        // symptom — this line is what makes that diagnosable in seconds
        // instead of during a demo.
        this.skipped[decision] = (this.skipped[decision] ?? 0) + 1;
        return;
      }

      void this.forwardTranscript(transcript, credentials.role);
    });

    await rtm.login({ token: credentials.rtmToken });
    await rtm.subscribe(channel, { withMessage: true });
    // Said out loud because "subscribed but silent" and "never subscribed"
    // look identical from the dashboard, and only one of them is a bug here.
    console.info(`[agora rtm] subscribed to ${channel} as uid ${credentials.uid}`);
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
