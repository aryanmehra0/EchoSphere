"use client";

import type { BridgeCredentials } from "./agora-bridge";
import type { AgoraTranscript } from "./agora-transcript";
import type { IncidentAction } from "./incident-reducer";
import type { ApprovalRequest, IncidentDelta, ParticipantRole, Transcript } from "./types";

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

/** Same approved boundary as the delta socket, expressed as HTTP for ingress. */
function slowLoopHttpUrl(): string {
  return slowLoopUrl()
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/deltas$/, "");
}

/** Zone 2 mints only short-lived participant credentials after roster writes. */
/**
 * Ask Zone 2 to put Echo in the channel — v6 W1.
 *
 * ── WHY THE CALLER MUST NOT AWAIT THIS BEFORE SHOWING THE DASHBOARD ────────
 * §17's standing rule: never let a change make the dashboard depend on the
 * Fast Loop. Inviting a Cloud Agent is a round trip to Agora that can take
 * seconds, time out, or fail on a bad TTS key — and none of that has anything
 * to do with whether the incident record works. So the invite is fired
 * alongside the join, and a failure costs Echo's voice and nothing else.
 *
 * Idempotent server-side, which matters because §18 puts two humans on two
 * machines and both consoles call this against the same channel.
 */
export async function inviteAgent(channel: string, userUid: number): Promise<{
  agentId: string | null;
  reused: boolean;
  registeredWithSlowLoop: boolean;
  /** Whether Echo can READ the Ledger, or must answer from its own memory. */
  toolsEnabled: boolean;
}> {
  const response = await fetch("/api/invite-agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The agent subscribes to exactly one participant, so it has to be told
    // WHICH one. Without this it heard nobody.
    body: JSON.stringify({ channel, userUid }),
  });
  const body = (await response.json()) as {
    agentId?: string;
    reused?: boolean;
    registeredWithSlowLoop?: boolean;
    toolsEnabled?: boolean;
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? `Agent invite failed (${response.status})`);
  return {
    agentId: body.agentId ?? null,
    reused: Boolean(body.reused),
    registeredWithSlowLoop: Boolean(body.registeredWithSlowLoop),
    toolsEnabled: Boolean(body.toolsEnabled),
  };
}

/**
 * End Echo's session. Leaving the RTC channel does NOT do this — the Cloud
 * Agent is a separate process that runs, and bills, until Agora times it out.
 */
export async function stopAgent(channel: string): Promise<void> {
  try {
    await fetch("/api/stop-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });
  } catch (error) {
    // Best-effort on the way out. An orphan times out on its own; blocking
    // the operator's exit on a cleanup call would be worse.
    console.warn("[bridge] could not stop the agent", error);
  }
}

export async function requestBridgeCredentials(
  channel: string,
  role: ParticipantRole,
): Promise<BridgeCredentials> {
  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, role }),
  });
  const body = (await response.json()) as Partial<BridgeCredentials> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Token request failed (${response.status})`);
  if (!body.appId || !body.rtcToken || !body.rtmToken || !body.uid) {
    throw new Error("Token response was incomplete");
  }
  return {
    appId: body.appId,
    rtcToken: body.rtcToken,
    rtmToken: body.rtmToken,
    uid: body.uid,
    role,
  };
}

/**
 * Who is on this bridge, and as what role — uid → role from the Roster.
 *
 * ── WHY IT LIVES IN THIS MODULE ────────────────────────────────────────────
 * Not because the bridge could not call it, but because Zone 1 egress is
 * confined to this file by a test, and the right response to needing a second
 * caller is to add the call HERE rather than to widen the allow-list. The
 * bridge imports this function; it opens no connection of its own.
 *
 * ── WHY THE CONSOLE NEEDS IT ───────────────────────────────────────────────
 * Echo subscribes to every participant, so this console receives the whole
 * room's finished turns and has to name each speaker. Attribution is the
 * product: filing one person's sentence under another's name is worse than
 * dropping it, because Rule 1 catches an unsourced claim and nothing catches a
 * mis-sourced one. The Roster is the only source of truth for uid → role.
 *
 * A failure here returns an EMPTY map rather than throwing. The caller then
 * attributes nobody, drops the turn, and retries on the next one — losing a
 * sentence, which is recoverable, instead of taking the bridge down, which is
 * not.
 */
export async function fetchRoster(
  channel: string,
): Promise<Map<number, ParticipantRole>> {
  const roles = new Map<number, ParticipantRole>();
  try {
    const response = await fetch(`/api/roster?channel=${encodeURIComponent(channel)}`);
    if (!response.ok) return roles;

    const body = (await response.json()) as {
      roles?: Record<string, ParticipantRole>;
      exclude?: number[];
    };
    // JSON turns numeric keys into strings. Parsing them back is the whole
    // reason this is not a one-liner: a uid arriving as "1001" and being looked
    // up as 1001 fails by silently skipping every utterance, not by throwing.
    const excluded = new Set(body.exclude ?? []);
    for (const [uid, role] of Object.entries(body.roles ?? {})) {
      const parsed = Number(uid);
      if (!Number.isFinite(parsed) || excluded.has(parsed)) continue;
      roles.set(parsed, role);
    }
  } catch {
    // Network hiccup mid-incident. Keep the caller's last good map.
  }
  return roles;
}

/** Final human ASR frames enter the Observer only through the approved egress. */
export async function forwardTranscriptToSlowLoop(
  transcript: AgoraTranscript,
  role: ParticipantRole,
): Promise<void> {
  const response = await fetch(`${slowLoopHttpUrl()}/observer/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...transcript, role }),
  });
  if (!response.ok) throw new Error(`Slow Loop returned HTTP ${response.status}`);
}
