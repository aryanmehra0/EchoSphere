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
  /**
   * Agora's Conversational AI Engine publishes transcripts to a STREAM
   * channel topic, which a MESSAGE-channel subscription never sees. Held so
   * `leave` can tear it down — an orphaned stream channel keeps the RTM
   * session alive and the next join then collides with it.
   */
  private stream: { leave: () => Promise<unknown> } | null = null;
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

    const stream = this.stream;
    this.stream = null;
    if (stream) {
      try {
        await stream.leave();
      } catch {
        // Already gone with the RTM session; nothing to unwind.
      }
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
    console.info(`[agora rtm] subscribed to MESSAGE channel ${channel} as uid ${credentials.uid}`);

    /*
      ── THE STREAM CHANNEL, AND WHY THE MESSAGE CHANNEL WAS NOT ENOUGH ──────
      RTM 2.x has two kinds of channel. `subscribe()` above joins a MESSAGE
      channel — plain pub/sub. Agora's Conversational AI Engine publishes
      transcripts to a STREAM channel TOPIC instead, and a message-channel
      subscription is simply never shown those frames.

      That is the shape of the failure measured on Aug 31: RTM logged in,
      `subscribe` resolved without error, sixty seconds of real audio played
      into the channel, and ZERO frames arrived. Nothing was broken in the
      sense of throwing — we were listening to the wrong kind of channel.

      TOPICS ARE DISCOVERED, NOT GUESSED. The engine's topic name is a vendor
      detail that has already cost hours of guessing, so instead of hardcoding
      one, this joins the stream channel and subscribes to whatever topics
      actually show up. If Agora renames it, this keeps working; if Agora
      publishes nothing, the log says so in as many words rather than leaving
      another silent gap.
    */
    try {
      const stream = rtm.createStreamChannel(channel);
      this.stream = stream;

      /*
        THE RTC TOKEN, NOT THE RTM ONE — and the error that proves it is:

            CAN_NOT_GET_GATEWAY_SERVER … Error Code -10005: Invalid token

        A stream channel is backed by the RTC gateway rather than the RTM
        message bus, so it is authorised by an RTC token minted for THIS
        channel and THIS uid. Logging the client in with the RTM token is
        necessary but not sufficient, and the failure names the gateway rather
        than the token, which sends you looking in the wrong place.
      */
      await stream.join({ token: credentials.rtcToken, withPresence: true });
      console.info(`[agora rtm] joined STREAM channel ${channel}`);

      const subscribed = new Set<string>();
      const subscribeTo = async (topicName: string) => {
        if (!topicName || subscribed.has(topicName)) return;
        subscribed.add(topicName);
        try {
          await stream.subscribeTopic(topicName);
          console.info(`[agora rtm] subscribed to topic "${topicName}"`);
        } catch (error) {
          subscribed.delete(topicName);
          console.warn(`[agora rtm] could not subscribe to "${topicName}"`, error);
        }
      };

      // Anyone joining a topic reveals its name — including the agent, which
      // starts publishing the moment it has something to say. The event
      // carries `topicInfos[]` rather than a single name: one event can
      // announce several topics, and the snapshot on join announces all of
      // them at once.
      rtm.addEventListener("topic", (event) => {
        console.info(
          `[agora rtm] topic event ${event.eventType} from ${event.publisher}:`,
          (event.topicInfos ?? []).map((t) => t.topicName).join(", ") || "(none)",
        );
        for (const info of event.topicInfos ?? []) {
          void subscribeTo(info.topicName);
        }
      });

      // The names Agora's engine is documented to use, tried up front so a
      // transcript that starts before any topic event still lands. Failures
      // here are expected and harmless — a topic that does not exist simply
      // does not subscribe.
      for (const candidate of ["chat", "subtitle", "transcription", "message"]) {
        void subscribeTo(candidate);
      }
    } catch (error) {
      /*
        ── THE ROOT CAUSE OF "SPEECH DOES NOTHING", TRACED Sep 1 ─────────────
        Losing the stream channel costs transcripts, not the dashboard — the
        Slow Loop keeps working on whatever is already in the Ledger. But the
        two failures that land here mean completely different things, and the
        generic message sent an investigation in the wrong direction twice:

          -10005  Invalid token / CAN_NOT_GET_GATEWAY_SERVER
                  The RTM token was passed to a stream-channel join. A stream
                  channel is backed by the RTC gateway and needs the RTC
                  token, which is why the error names a gateway.

          -11012  DATASTREAM2_NOT_AVAILABLE
                  NOT A CODE PROBLEM. Stream Channel is not enabled on the
                  Agora project. The Conversational AI Engine then has nowhere
                  to publish transcripts, so speech reaches the channel, Agora
                  transcribes it for its own turn-taking, and the console
                  never sees a word. Enable it in the Agora Console under the
                  project's Real-Time Messaging configuration.

        Named explicitly here because the symptom — a live bridge that fills
        with nothing — is identical for both, and identical to a dozen other
        causes.
      */
      const detail = message(error);
      const hint = detail.includes("-11012") || detail.includes("not available for this app id")
        ? "Stream Channel is not enabled on this Agora project — enable RTM Stream Channel in the Agora Console. Speech will not reach the Ledger until it is."
        : detail.includes("-10005")
          ? "The stream channel rejected the token. It needs the RTC token, not the RTM one."
          : detail;

      console.warn(`[agora rtm] stream channel unavailable — ${hint}`, error);
      this.events.onError(`NO TRANSCRIPTS — ${hint}`);
    }
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
