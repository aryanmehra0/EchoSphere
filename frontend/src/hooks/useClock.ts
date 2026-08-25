"use client";

import { useSyncExternalStore } from "react";

/**
 * The console's single 1Hz clock.
 *
 * The wall clock is an EXTERNAL system, not React state, so it is subscribed to
 * with `useSyncExternalStore` rather than nursed along by a `setState` inside an
 * effect. That buys three things:
 *
 *   - No cascading render on mount, and no hydration mismatch: the server
 *     snapshot is a fixed 0, and components render "--:--" until the client
 *     takes over on the first real tick.
 *   - One interval for the entire application. Every elapsed timer and the
 *     status-bar clock read the same store, so two counters can never disagree
 *     by a second — which is exactly the sort of detail that makes an ops tool
 *     feel untrustworthy.
 *   - The interval is owned by the subscription, so it stops the moment the
 *     last consumer unmounts.
 *
 * The snapshot is floored to the second deliberately: `getSnapshot` must be
 * stable between ticks or React will re-render in a loop.
 */

type Listener = () => void;

const listeners = new Set<Listener>();
let interval: ReturnType<typeof setInterval> | null = null;
let snapshot = 0;

function tick() {
  snapshot = Math.floor(Date.now() / 1000) * 1000;
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  if (interval === null) {
    // Publish immediately so the first paint after mount shows a real time
    // rather than waiting a full second.
    tick();
    interval = setInterval(tick, 1000);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
}

const getSnapshot = () => snapshot;

/** Server and first client render agree on 0, which formatters render as "--". */
const getServerSnapshot = () => 0;

/** Current wall-clock time in ms, floored to the second. 0 before hydration. */
export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
