"use client";

import type { IncidentAction } from "./incident-reducer";
import type { ApprovalRequest, IncidentDelta, Transcript } from "./types";

/**
 * The dashboard's half of the reconnect protocol — v6 §9.3, closing G6.
 *
 * ── WHY THIS FILE IS THE ONLY EGRESS IN THE CLIENT TREE ─────────────────────
 * A blast-radius test asserts that no client module opens a raw socket, because
 * an unreviewed outbound connection in the browser is exactly the surface §10.2
 * exists to bound. That test now permits precisely this module and nothing else,
 * which is what its own comment anticipated: "when the Phase 3 delta socket
 * lands it will live behind a named module and this test will be narrowed to
 * permit exactly that one."
 *
 * So: all dashboard egress goes through here, and it talks to one place — the
 * Slow Loop's delta socket.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE PROTOCOL
 *
 *   → HELLO    { lastSeq: number | null }
 *   ← SNAPSHOT { seq, state }      fresh connection, or a gap too large to replay
 *   ← REPLAY   { seq, payload }    the gap was inside the server's ring buffer
 *   ← DELTA    { seq, payload }    steady state
 *
 * Two properties make this safe:
 *
 *   1. The reducer merges by `id` and is idempotent, so a replayed delta is a
 *      no-op. That is what lets the server choose REPLAY or SNAPSHOT freely
 *      without the client reconciling anything.
 *   2. We track `lastSeq` and detect gaps WHILE CONNECTED. A seq jump means a
 *      dropped frame, and silent divergence is the failure mode that would be
 *      hardest to notice on stage — the graph would simply be quietly wrong.
 */

export type SocketStatus =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed";

interface Options {
  url: string;
  /** Every action is dispatched straight into the incident reducer. */
  dispatch: (action: IncidentAction) => void;
  onStatus?: (status: SocketStatus) => void;
  /** Called when the socket cannot be established at all, so the caller can
   *  fall back to the scripted replay — v6 §17: the dashboard is the fallback
   *  demo, and it must never depend on the Slow Loop being up. */
  onUnavailable?: () => void;
}

export interface DeltaSocket {
  close: () => void;
}

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 600;

/** The server sends transcripts inside the delta payload; they take a different
 *  reducer path because dedup by `messageId` lives in the TRANSCRIPT case. */
interface WirePayload extends IncidentDelta {
  transcripts?: Transcript[];
}

export function openDeltaSocket({
  url,
  dispatch,
  onStatus,
  onUnavailable,
}: Options): DeltaSocket {
  let ws: WebSocket | null = null;
  let lastSeq: number | null = null;
  let attempts = 0;
  let closedByCaller = false;
  let retryTimer: number | null = null;

  const status = (s: SocketStatus) => onStatus?.(s);

  /**
   * Split a payload into the actions the reducer understands.
   *
   * Transcripts are dispatched individually so each one goes through the
   * dedup path; everything else is one DELTA, which keeps the render count
   * down when a batch arrives.
   */
  function apply(payload: WirePayload) {
    const { transcripts, ...delta } = payload;

    for (const t of transcripts ?? []) {
      dispatch({ type: "TRANSCRIPT", payload: t });
    }

    // Object.keys rather than a truthiness check: a delta carrying only
    // `rti: 0` or `phase` is still meaningful.
    if (Object.keys(delta).length > 0) {
      dispatch({ type: "DELTA", payload: delta as IncidentDelta });
    }
  }

  function connect() {
    if (closedByCaller) return;

    status(attempts === 0 ? "connecting" : "reconnecting");

    try {
      ws = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }

    ws.onopen = () => {
      attempts = 0;
      status("live");
      // Announce what we already have. `null` asks for a full snapshot.
      ws?.send(JSON.stringify({ kind: "HELLO", lastSeq }));
    };

    ws.onmessage = (event) => {
      let msg: {
        kind?: string;
        seq?: number;
        payload?: WirePayload;
        state?: WirePayload;
        approval?: ApprovalRequest;
      };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return; // a malformed frame must never take the dashboard down
      }

      if (msg.kind === "APPROVAL_REQUEST" && msg.approval) {
        // Out-of-band control traffic: deliberately carries no `seq`, because
        // giving it one would make a reconnecting client think it had missed
        // a delta.
        dispatch({ type: "APPROVAL_REQUEST", payload: msg.approval });
        return;
      }

      if (msg.kind === "SNAPSHOT") {
        lastSeq = msg.seq ?? null;
        if (msg.state) {
          // Replace rather than merge: a snapshot is the server's authoritative
          // view, and merging would preserve rows it has since dropped.
          dispatch({ type: "SNAPSHOT", payload: msg.state });
        }
        return;
      }

      if (msg.kind === "DELTA" || msg.kind === "REPLAY") {
        const seq = msg.seq ?? 0;

        // Gap detection while connected. A jump means we missed a frame, and
        // the cheapest correct recovery is to reconnect and let the server
        // decide between REPLAY and SNAPSHOT.
        if (lastSeq !== null && seq > lastSeq + 1) {
          console.warn(
            `[deltas] gap detected: expected ${lastSeq + 1}, got ${seq} — resyncing`,
          );
          ws?.close();
          return;
        }

        lastSeq = seq;
        if (msg.payload) apply(msg.payload);
      }
    };

    ws.onclose = () => {
      if (closedByCaller) return;
      scheduleRetry();
    };

    ws.onerror = () => {
      // `onclose` always follows, so retry scheduling lives there only.
      ws?.close();
    };
  }

  function scheduleRetry() {
    attempts += 1;

    if (attempts > MAX_ATTEMPTS) {
      status("failed");
      onUnavailable?.();
      return;
    }

    status("reconnecting");
    const delay = BASE_BACKOFF_MS * 2 ** (attempts - 1);
    retryTimer = window.setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
      ws = null;
      status("idle");
    },
  };
}

/**
 * Where the Slow Loop lives. `NEXT_PUBLIC_` because the browser needs it, and
 * it is not a secret — it is a localhost URL in development and a public
 * endpoint in deployment.
 */
export function slowLoopUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SLOW_LOOP_WS ?? "ws://127.0.0.1:8000/ws/deltas"
  );
}
