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
  slowLoopUrl,
  type DeltaSocket,
} from "./delta-socket";
import type { IncidentState } from "./types";

/**
 * Where the incident data on screen is coming from.
 *
 * Surfaced in the status bar rather than hidden, because an operator — or a
 * judge — must never be unsure whether they are watching a live bridge or a
 * rehearsal. Silently falling back to a scripted replay and letting someone
 * believe it is live would be its own kind of epistemic failure.
 */
export type DataSource = "live" | "replay" | null;

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
  openBridge: () => void;
  closeBridge: () => void;
  micOn: boolean;
  toggleMic: () => void;
  /** live = Slow Loop socket, replay = scripted fallback, null = idle. */
  source: DataSource;
}

const Ctx = createContext<IncidentStore | null>(null);

export function IncidentProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(incidentReducer, initialIncidentState);
  const [micOn, setMicOn] = useState(true);
  const [source, setSource] = useState<DataSource>(null);

  /** The live delta socket, when one is open. */
  const socket = useRef<DeltaSocket | null>(null);

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

  const openBridge = useCallback(() => {
    clearTimers();
    socket.current?.close();
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
        // The Slow Loop is not up. Say so once, then run the rehearsal so the
        // dashboard is never a blank screen in front of a judge.
        console.info("[bridge] Slow Loop unreachable — falling back to the scripted replay");
        socket.current = null;
        startReplay();
      },
    });
  }, [clearTimers, startReplay]);

  const closeBridge = useCallback(() => {
    clearTimers();
    socket.current?.close();
    socket.current = null;
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
    };
  }, [clearTimers]);

  const toggleMic = useCallback(() => setMicOn((v) => !v), []);

  const value = useMemo<IncidentStore>(
    () => ({ state, dispatch, now, openBridge, closeBridge, micOn, toggleMic, source }),
    [state, now, openBridge, closeBridge, micOn, toggleMic, source],
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
