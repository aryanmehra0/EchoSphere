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
import type { IncidentState } from "./types";

/**
 * The console's state container.
 *
 * There is exactly one of these, mounted at the root of the client tree. Panels
 * subscribe to it rather than passing incident data down through props, because
 * the three columns need overlapping slices of the same state and prop-drilling
 * across a three-column console is how these dashboards rot.
 *
 * ── PHASE 2/3 INTEGRATION POINT ──────────────────────────────────────────────
 * `openBridge()` currently starts the scripted replay. To go live:
 *
 *   1. Phase 2 — replace the replay with the Agora RTC join + RTM subscribe,
 *      and dispatch `{ type: "TRANSCRIPT", payload }` from the RTM handler.
 *   2. Phase 3 — open the analytics WebSocket and dispatch
 *      `{ type: "DELTA", payload: JSON.parse(event.data) }`.
 *
 * Nothing below this file changes. The component tree has no idea where its
 * actions come from, which is the entire point of routing everything through
 * one reducer.
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
}

const Ctx = createContext<IncidentStore | null>(null);

export function IncidentProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(incidentReducer, initialIncidentState);
  const [micOn, setMicOn] = useState(true);

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

  const openBridge = useCallback(() => {
    clearTimers();
    dispatch({ type: "RESET" });
    dispatch({ type: "BRIDGE", state: "connecting" });

    // A short connecting phase before "live". This is not theatre — the real
    // Agora join is genuinely async, and building the UI as if it were
    // instant is how you end up with no connecting state at all in Phase 2.
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
  }, [clearTimers]);

  const closeBridge = useCallback(() => {
    clearTimers();
    dispatch({ type: "BRIDGE", state: "closing" });
    timers.current.push(
      window.setTimeout(() => dispatch({ type: "RESET" }), 400),
    );
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const toggleMic = useCallback(() => setMicOn((v) => !v), []);

  const value = useMemo<IncidentStore>(
    () => ({ state, dispatch, now, openBridge, closeBridge, micOn, toggleMic }),
    [state, now, openBridge, closeBridge, micOn, toggleMic],
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
