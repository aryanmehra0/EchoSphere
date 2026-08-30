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
  openDeltaSocket,
  requestBridgeCredentials,
  slowLoopUrl,
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

  /**
   * A single shared 1Hz tick drives every elapsed timer in the console.
   * Individual components must not run their own intervals — a dozen unsynced
   * timers is both wasteful and visibly ragged when two counters disagree.
   * See `useClock` for why this is an external store rather than local state.
   */
  const now = useClock();

  /** Handles for the in-flight replay, so closing the bridge can cancel it. */
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => {
    const transport = new AgoraBridge({
      onAgentTrack: setAgentTrack,
      onAgentState: (agent) => dispatch({ type: "AGENT", state: agent }),
      onError: (detail) => console.warn(`[agora bridge] ${detail}`),
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

    clearTimers();
    socket.current?.close();
    socket.current = null;
    await agora.current?.leave();
    setAgentTrack(null);
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

    try {
      const credentials = await requestBridgeCredentials(cleanChannel, role);
      await agora.current?.join(cleanChannel, credentials);
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
    }
  }, [clearTimers, startReplay]);

  const closeBridge = useCallback(() => {
    clearTimers();
    socket.current?.close();
    socket.current = null;
    void agora.current?.leave();
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
