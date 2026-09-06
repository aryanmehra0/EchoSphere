"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useClock } from "@/hooks/useClock";

import {
  incidentReducer,
  initialIncidentState,
  type IncidentAction,
} from "./incident-reducer";
import { DEMO_SCRIPT, rebaseAction } from "./mock-stream";
import {
  inviteAgent,
  openDeltaSocket,
  requestBridgeCredentials,
  slowLoopUrl,
  stopAgent,
  type DeltaSocket,
} from "./delta-socket";
import { AgoraBridge } from "./agora-bridge";
import type { IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import type { IncidentState, ParticipantRole } from "./types";

/**
 * Where the incident data on screen is coming from.
 *
 * Surfaced in the status bar rather than hidden, because an operator — or a
 * judge — must never be unsure whether they are watching a live bridge or a
 * rehearsal. Silently falling back to a scripted replay and letting someone
 * believe it is live would be its own kind of epistemic failure.
 */
export type DataSource = "live" | "replay" | null;

export interface BridgeJoinOptions {
  channel: string;
  role: ParticipantRole;
}

/**
 * The console's state container.
 *
 * There is exactly one of these, mounted at the root of the client tree. Panels
 * subscribe to it rather than passing incident data down through props, because
 * the three columns need overlapping slices of the same state and prop-drilling
 * across a three-column console is how these dashboards rot.
 *
 * ── DATA SOURCES ─────────────────────────────────────────────────────────────
 * `openBridge()` opens the Slow Loop delta socket (v6 §9.3) and falls back to
 * the scripted replay if the Python service is unreachable. Both paths dispatch
 * the SAME `IncidentAction`s into the SAME reducer, so no component below this
 * file knows or cares which one is feeding it — that indifference is the entire
 * point of routing everything through one reducer, and it is what makes the
 * fallback in §17 ("the dashboard is the fallback demo") free rather than a
 * second code path to maintain.
 *
 * Still outstanding: the local RTC join, so the operator's own microphone
 * reaches the channel from this console rather than from `public/listen.html`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface IncidentStore {
  state: IncidentState;
  dispatch: (action: IncidentAction) => void;
  /** Monotonic clock for elapsed timers, ticking once per second. */
  now: number;
  openBridge: (options: BridgeJoinOptions) => void;
  closeBridge: () => void;
  micOn: boolean;
  toggleMic: () => void;
  /** live = Slow Loop socket, replay = scripted fallback, null = idle. */
  source: DataSource;
  /** Remote Echo track for the visual envelope, never incident data. */
  agentTrack: IRemoteAudioTrack | null;
}

const Ctx = createContext<IncidentStore | null>(null);

export function IncidentProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(incidentReducer, initialIncidentState);
  const [micOn, setMicOn] = useState(true);
  const [source, setSource] = useState<DataSource>(null);
  const [agentTrack, setAgentTrack] = useState<IRemoteAudioTrack | null>(null);

  /** The live delta socket, when one is open. */
  const socket = useRef<DeltaSocket | null>(null);
  const agora = useRef<AgoraBridge | null>(null);
  /** The channel Echo was invited to, so leaving can stop the right agent. */
  const joinedChannel = useRef<string | null>(null);

  /**
   * A single shared 1Hz tick drives every elapsed timer in the console.
   * Individual components must not run their own intervals — a dozen unsynced
   * timers is both wasteful and visibly ragged when two counters disagree.
   * See `useClock` for why this is an external store rather than local state.
   */
  const now = useClock();

  /** Handles for the in-flight replay, so closing the bridge can cancel it. */
  const timers = useRef<number[]>([]);

  /**
   * A join already in flight, so a second one cannot start on top of it.
   *
   * ── WHY THIS IS NOT DEFENSIVE PROGRAMMING ───────────────────────────────
   * `openBridge` is reachable from the J key AND the button, neither of which
   * debounced. Pressing J twice, or clicking while the first join is still
   * negotiating, ran the whole sequence concurrently — and the second run
   * constructed a SECOND RTM client for the same uid before the first had
   * finished logging out. Agora says so directly:
   *
   *     <RTM> Ins id is 2, please pay attention to avoid mutual kick issues
   *
   * The two instances then kick each other. RTM is where the transcript feed
   * arrives (`data_channel: "rtm"`), so the loser stops receiving transcripts
   * entirely — which is the "it stops listening to the other person" that
   * looked like a timeout but never recovered, because nothing retries a
   * connection that believes it is still open.
   */
  const joining = useRef(false);

  const clearTimers = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => {
    const transport = new AgoraBridge({
      onAgentTrack: setAgentTrack,
      onAgentState: (agent) => dispatch({ type: "AGENT", state: agent }),
      /*
        ── ON SCREEN, NOT ONLY IN THE DEVTOOLS CONSOLE ─────────────────────
        This was `console.warn` alone, which meant the transport's loudest
        message — "NO TRANSCRIPTS — <reason>" — reached nobody. The operator
        saw an empty transcript panel and no explanation, and both times this
        failed for real it was diagnosed by reading Agora's REST history from
        a shell rather than by looking at the product.

        The degradation banner already exists for exactly this: one short line
        naming the CONSEQUENCE. Voice is marked degraded because that is what
        losing transcripts costs — the incident record, not the call.
      */
      onError: (detail) => {
        console.warn(`[agora bridge] ${detail}`);
        dispatch({
          type: "DELTA",
          payload: {
            degraded: {
              voice: true,
              extraction: false,
              model: null,
              banner: detail.slice(0, 140),
            },
          },
        });
      },
    });
    agora.current = transport;

    return () => {
      void transport.leave();
      if (agora.current === transport) agora.current = null;
    };
  }, []);

  /**
   * The scripted replay — v6 §17's fallback demo.
   *
   * "Never let a change make the dashboard depend on the Fast Loop." The same
   * discipline applies to the Slow Loop: if the Python service is not running,
   * the console must still tell the whole story. This is that path, and it is
   * unchanged from Phase 1.
   */
  const startReplay = useCallback(() => {
    setSource("replay");

    const HANDSHAKE = 900;
    const epoch = Date.now() + HANDSHAKE;

    timers.current.push(
      window.setTimeout(() => {
        dispatch({ type: "BRIDGE", state: "live", at: epoch });
      }, HANDSHAKE),
    );

    for (const frame of DEMO_SCRIPT) {
      timers.current.push(
        window.setTimeout(
          // Rebased onto the real join time; the fixture stores offsets, and
          // the UI formats these as wall-clock times of day.
          () => dispatch(rebaseAction(frame.action, epoch)),
          HANDSHAKE + frame.at,
        ),
      );
    }
  }, []);

  const openBridge = useCallback(async ({ channel, role }: BridgeJoinOptions) => {
    const cleanChannel = channel.trim();
    if (!cleanChannel) return;

    // See `joining` above: a concurrent join creates a second RTM client for
    // the same uid, and the two kick each other off the transcript feed.
    if (joining.current) {
      console.info("[bridge] join already in progress — ignoring duplicate request");
      return;
    }
    joining.current = true;

    clearTimers();
    socket.current?.close();
    socket.current = null;
    await agora.current?.leave();
    setAgentTrack(null);

    /*
      ── CLEAR THE BANNER BEFORE TRYING, NOT ONLY AFTER SUCCEEDING ──────────
      A previous failed join leaves "NO MICROPHONE — you can watch, but the
      room cannot hear you" on screen, and it was only lowered at the END of a
      SUCCESSFUL join. So a retry that worked still showed the old warning for
      its whole duration, and a retry that reached "Listening" while the banner
      stayed up produced a screen that contradicted itself: a red NO MICROPHONE
      bar directly above a live "Microphone open" control.

      An operator cannot act on a contradiction. Clear the stale verdict up
      front; this attempt will publish its own.
    */
    dispatch({
      type: "DELTA",
      payload: {
        degraded: { voice: false, extraction: false, model: null, banner: null },
      },
    });
    setMicOn(true);
    dispatch({ type: "RESET" });
    dispatch({ type: "BRIDGE", state: "connecting" });

    /**
     * Try the Slow Loop first, fall back to the replay.
     *
     * The component tree cannot tell the difference — both paths dispatch the
     * same `IncidentAction`s into the same reducer, which is the entire point
     * of routing everything through one reducer. Only the status bar knows,
     * because an operator deserves to know whether they are looking at a live
     * incident or a rehearsal.
     */
    /*
      ORDER MATTERS: evidence path first, microphone second.

      §17's standing rule is "never let a change make the dashboard depend on
      the Fast Loop", and joining Agora before opening the delta socket breaks
      exactly that. A denied microphone permission, a stale token, a laptop with
      no input device — any of those would have taken the LIVE DASHBOARD down
      with them, even though the Slow Loop was healthy and everyone else's
      speech was still being transcribed and analysed.

      So the socket opens first and the dashboard is live regardless. The RTC
      join is then attempted, and if it fails we lose only this operator's
      microphone: they can still watch a real incident unfold, and the console
      says which capability was lost rather than silently pretending.
    */
    socket.current = openDeltaSocket({
      url: slowLoopUrl(),
      dispatch,
      onStatus: (s) => {
        if (s === "live") {
          setSource("live");
          dispatch({ type: "BRIDGE", state: "live", at: Date.now() });
        }
      },
      onUnavailable: () => {
        // A live microphone with no evidence path is misleading — speech would
        // reach the channel and nothing would record it.
        void agora.current?.leave();
        setAgentTrack(null);
        // The Slow Loop is not up. Say so once, then run the rehearsal so the
        // dashboard is never a blank screen in front of a judge.
        console.info("[bridge] Slow Loop unreachable — falling back to the scripted replay");
        socket.current = null;
        startReplay();
      },
    });

    /*
      PUT ECHO IN THE CHANNEL — v6 W1.

      Deliberately NOT awaited before the join, and deliberately not allowed to
      throw into it. Inviting a Cloud Agent is a round trip to Agora that can
      take seconds or fail outright on a bad TTS key; §17 says the dashboard
      must never depend on the Fast Loop, and that includes not waiting on it.

      This call was missing entirely until Aug 31. Every other link worked —
      tokens minted, RTC joined, claims extracted, contradictions detected —
      and Echo was never in the room to say any of it. Nothing errored. It was
      simply silent, which is the hardest kind of bug to see.
    */
    joinedChannel.current = cleanChannel;

    /*
      ORDER: credentials FIRST, because this browser needs its own UID before
      it can join RTC or label the speech it forwards.

      Echo itself now subscribes to `["*"]` — every participant in the channel,
      per Agora's documented wildcard — so the invite no longer decides who
      Echo can hear. It passes this UID for the Roster and the audit trail, not
      to pick a single listener. (An earlier comment here claimed `"*"` was not
      a wildcard and that the agent had to be told which one person to hear.
      That was wrong, and it made Echo deaf to everyone but the first joiner —
      see agent-config.ts and session_log §7.)

      §17 still holds. The dashboard is already live by this point — the delta
      socket opened above — so neither of these calls can take it down, and the
      invite remains unawaited so a slow Agora cannot stall the join.
    */
    try {
      const credentials = await requestBridgeCredentials(cleanChannel, role);

      void inviteAgent(cleanChannel, credentials.uid)
        .then(({ agentId, registeredWithSlowLoop, toolsEnabled }) => {
          if (!agentId) {
            console.warn("[bridge] Agora accepted the invite but returned no agent id");
            return;
          }
          console.info(
            `[bridge] Echo joined as ${agentId}, listening to uid ${credentials.uid}` +
              `${toolsEnabled ? " with Ledger tools" : " WITHOUT tools"}`,
          );
          if (!registeredWithSlowLoop) {
            // Echo is audible but will never speak ABOUT the incident. That
            // distinction is impossible to work out from inside the room, so
            // it gets said out loud rather than discovered on stage.
            dispatch({
              type: "DELTA",
              payload: {
                degraded: {
                  voice: true,
                  extraction: false,
                  model: null,
                  banner: "ECHO CANNOT SPEAK — the Slow Loop never received the agent id",
                },
              },
            });
          }
        })
        .catch((error) => {
          console.warn("[bridge] agent invite failed — dashboard is unaffected", error);
          dispatch({
            type: "DELTA",
            payload: {
              degraded: {
                voice: true,
                extraction: false,
                model: null,
                banner: "NO VOICE — Echo could not join the bridge",
              },
            },
          });
        });

      await agora.current?.join(cleanChannel, credentials);

      /*
        ── A SUCCESSFUL JOIN CLEARS THE BANNER ────────────────────────────────
        Nothing else ever did. `onError` raises the degradation banner and no
        path lowered it, so any transient failure — a lost subscribe race, a
        tunnel blip, an invite that succeeded on retry — left "NO VOICE" on
        screen permanently over a bridge that was working perfectly.

        A banner that cannot clear itself stops being information and becomes
        noise people learn to ignore, which is worse than not having one: the
        NEXT genuine failure is the one nobody looks at. So reaching the end of
        a join with no throw is treated as the positive evidence it is.
      */
      dispatch({
        type: "DELTA",
        payload: {
          degraded: { voice: false, extraction: false, model: null, banner: null },
        },
      });
    } catch (error) {
      // Voice is gone; the incident record is not. This is the ANALYTICS-ONLY
      // rung of §13's ladder, and the operator is told rather than left to
      // wonder why nobody can hear them.
      console.warn("[bridge] RTC join failed — continuing without a microphone", error);
      await agora.current?.leave();
      setAgentTrack(null);
      dispatch({
        type: "DELTA",
        payload: {
          degraded: {
            voice: true,
            extraction: false,
            model: null,
            banner: "NO MICROPHONE — you can watch, but the room cannot hear you",
          },
        },
      });
    } finally {
      // Released on EVERY path — success, throw, or the degraded fallback.
      // A flag left set would block every future join with no way back.
      joining.current = false;
    }
  }, [clearTimers, startReplay]);

  const closeBridge = useCallback(() => {
    clearTimers();
    socket.current?.close();
    socket.current = null;
    void agora.current?.leave();
    // Leaving RTC does NOT stop the Cloud Agent — it is a separate process
    // that keeps running, and billing, until Agora times it out. Rehearsing
    // ten times without this leaves ten Echoes in the channel.
    if (joinedChannel.current) {
      void stopAgent(joinedChannel.current);
      joinedChannel.current = null;
    }
    setAgentTrack(null);
    setMicOn(true);
    setSource(null);
    dispatch({ type: "BRIDGE", state: "closing" });
    timers.current.push(
      window.setTimeout(() => dispatch({ type: "RESET" }), 400),
    );
  }, [clearTimers]);

  useEffect(() => {
    return () => {
      clearTimers();
      socket.current?.close();
      void agora.current?.leave();
      if (joinedChannel.current) void stopAgent(joinedChannel.current);
    };
  }, [clearTimers]);

  const toggleMic = useCallback(() => {
    const next = !micOn;
    void agora.current?.setMuted(!next)
      .then(() => setMicOn(next))
      .catch((error) => console.warn("[bridge] microphone update failed", error));
  }, [micOn]);

  const value = useMemo<IncidentStore>(
    () => ({
      state,
      dispatch,
      now,
      openBridge,
      closeBridge,
      micOn,
      toggleMic,
      source,
      agentTrack,
    }),
    [state, now, openBridge, closeBridge, micOn, toggleMic, source, agentTrack],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useIncident(): IncidentStore {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useIncident must be used inside <IncidentProvider>");
  }
  return ctx;
}
