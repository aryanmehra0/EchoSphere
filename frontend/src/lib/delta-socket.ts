"use client";

import type { BridgeCredentials } from "./agora-bridge";
import type { AgoraTranscript } from "./agora-transcript";
import type { IncidentAction } from "./incident-reducer";
import type {
  ApprovalRequest,
  Claim,
  ConnectorConfig,
  ConnectorProvider,
  ConnectorStatus,
  IncidentChannelSummary,
  IncidentDelta,
  ParticipantRole,
  PostMortemResponse,
  ProjectWorkspace,
  RosterParticipant,
  TelemetryReading,
  Transcript,
  UserProfile,
} from "./types";

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
  channel?: string;
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
/** Ceiling for the backoff between attempts. See `scheduleRetry`. */
const MAX_BACKOFF_MS = 1500;

/**
 * How long a WebSocket may sit in CONNECTING before we give up on it.
 *
 * ── WHY A TIMEOUT IS REQUIRED AND NOT DEFENSIVE ────────────────────────────
 * A WebSocket that cannot complete its handshake does not necessarily fail.
 * Point one at a host that accepts TCP but never upgrades - a tunnel that
 * proxies HTTP but not `/ws/deltas`, a load balancer, a captive portal - and
 * `onopen`, `onclose` and `onerror` ALL stay silent. The browser holds the
 * connection open and waits.
 *
 * Every retry in this module hangs off `onclose`, so nothing fired: no retry,
 * no `onUnavailable`, no scripted-replay fallback. The console sat on
 * "Connecting to bridge" indefinitely while the RTC side was completely
 * healthy - microphone live, Echo listening and answering out loud. Reported
 * from a guest on a shared tunnel, and it is the most confusing failure this
 * console can produce, because everything audible works and the screen
 * contradicts it.
 *
 * The budget is for the LADDER, not one attempt.
 * At a flat 8s per attempt the full ladder measured 49 SECONDS before the
 * replay started - four hung handshakes plus backoff - which is far too long
 * to leave a button claiming to connect. But the first attempt cannot be made
 * aggressive without breaking a genuinely slow link: a real handshake over a
 * quick tunnel measures ~1-2s, and a cold one can take longer.
 *
 * So the timeout tightens as confidence drops. The first attempt is patient
 * enough for a slow-but-real connection; once one attempt has already hung,
 * the remainder are almost certainly hung too and there is no reason to spend
 * another eight seconds each proving it. Total ladder: ~14s.
 */
const CONNECT_TIMEOUT_MS = 6000;
/** Later attempts: one hang already tells us the endpoint is not speaking. */
const CONNECT_RETRY_TIMEOUT_MS = 2000;

/** The server sends transcripts inside the delta payload; they take a different
 *  reducer path because dedup by `messageId` lives in the TRANSCRIPT case. */
interface WirePayload extends IncidentDelta {
  transcripts?: Transcript[];
}

function withChannel(url: string, channel: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("channel", channel);
    return u.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}channel=${encodeURIComponent(channel)}`;
  }
}

export function openDeltaSocket({
  url,
  channel,
  dispatch,
  onStatus,
  onUnavailable,
}: Options): DeltaSocket {
  const socketUrl = channel ? withChannel(url, channel) : url;
  let ws: WebSocket | null = null;
  let lastSeq: number | null = null;
  let attempts = 0;
  /*
    ── WHY A GENERATION COUNTER ─────────────────────────────────────────────
    `ws.close()` (the gap-detection path below, and the handshake-timeout
    path above) does not synchronously discard messages the browser already
    queued for that socket — a late `onmessage` for the OLD connection can
    still fire after `connect()` has already created a NEW one. Both
    closures share the same `lastSeq` variable, so a stale frame arriving
    after the new socket already advanced it (via its own SNAPSHOT/DELTA)
    could overwrite `lastSeq` backward, and — since the reducer's upserts
    are keyed by id, not guarded by seq — actually re-apply stale data over
    newer state.

    Every handler attached in `connect()` checks `myGeneration === generation`
    before doing anything, so a callback from a socket `connect()` has since
    superseded is a no-op, full stop — not just for `lastSeq`, for the
    handler's entire body.
  */
  let generation = 0;
  let closedByCaller = false;
  /** Fires if the handshake never resolves. Cleared by open, close or retry. */
  let connectTimer: number | null = null;
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

    // This connection's identity. Every handler below closes over this
    // value (not the mutable `generation` variable directly) and checks it
    // against the current `generation` before acting — see the field
    // comment above `generation`'s declaration.
    const myGeneration = ++generation;

    try {
      ws = new WebSocket(socketUrl);
    } catch {
      scheduleRetry();
      return;
    }

    /*
      A handshake that never resolves is a failure, and the browser will not
      tell us. Abandon the socket ourselves so the retry ladder - and
      ultimately `onUnavailable` and the scripted replay - still runs.

      `close()` on a CONNECTING socket fires `onclose`, which is what schedules
      the retry, so this timer deliberately does not call `scheduleRetry`
      itself. The pending socket is detached first so its late `onclose`
      cannot retry a second time.
    */
    const pending = ws;
    const budget = attempts === 0 ? CONNECT_TIMEOUT_MS : CONNECT_RETRY_TIMEOUT_MS;
    connectTimer = window.setTimeout(() => {
      connectTimer = null;
      if (closedByCaller) return;
      if (pending.readyState !== WebSocket.CONNECTING) return;
      console.warn(
        `[deltas] no handshake from ${url} in ${budget}ms — treating as unreachable`,
      );
      // Silence the dead socket, then advance the ladder exactly once.
      pending.onopen = null;
      pending.onclose = null;
      pending.onerror = null;
      pending.onmessage = null;
      try { pending.close(); } catch { /* already dying */ }
      if (ws === pending) ws = null;
      scheduleRetry();
    }, budget);

    ws.onopen = () => {
      if (myGeneration !== generation) return; // superseded — see `generation` above
      clearConnectTimer();
      attempts = 0;
      status("live");
      // Announce what we already have. `null` asks for a full snapshot.
      ws?.send(JSON.stringify({ kind: "HELLO", lastSeq }));
    };

    ws.onmessage = (event) => {
      if (myGeneration !== generation) return; // a stale socket's queued message — ignore entirely
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
        // Unconditional, unlike the DELTA/REPLAY guard below: a snapshot is
        // the server's authoritative current state regardless of how its
        // seq compares to whatever this client saw before.
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

        // Monotonic backstop: even with the generation guard above, refuse
        // to move `lastSeq` backward or re-apply a payload this client has
        // already moved past. Belt-and-suspenders — the generation guard
        // should already have caught a stale-socket message, but a
        // reused/miscounted seq from the SAME socket costs nothing extra
        // to also refuse here.
        if (lastSeq !== null && seq <= lastSeq) return;

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
      if (myGeneration !== generation) return; // a newer socket already exists — don't double-schedule a retry
      clearConnectTimer();
      if (closedByCaller) return;
      scheduleRetry();
    };

    ws.onerror = () => {
      // `onclose` always follows, so retry scheduling lives there only.
      ws?.close();
    };
  }

  function clearConnectTimer() {
    if (connectTimer !== null) {
      window.clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function scheduleRetry() {
    clearConnectTimer();
    attempts += 1;

    if (attempts > MAX_ATTEMPTS) {
      status("failed");
      onUnavailable?.();
      return;
    }

    status("reconnecting");
    /*
      Capped. Uncapped exponential backoff (600/1200/2400/4800ms) put the
      last retry 4.8s after the one before it, and with four attempts that
      backoff alone was most of the wait before the replay took over.

      A cap keeps the early retries cheap - which is what backoff is FOR,
      giving a briefly-flapping socket room to recover - without letting the
      tail dominate. The dashboard is blank until this ladder finishes, so
      every second here is a second of nothing on screen.
    */
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    retryTimer = window.setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      // Otherwise a socket still mid-handshake keeps its timer, which fires
      // after the caller has gone and schedules a retry for a closed socket.
      clearConnectTimer();
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
export function slowLoopUrl(channel?: string): string {
  const configured = process.env.NEXT_PUBLIC_SLOW_LOOP_WS?.trim();
  if (configured) return channel ? withChannel(configured, channel) : configured;

  /*
    ── A GUEST'S 127.0.0.1 IS THEIR OWN LAPTOP, NOT THE HOST'S ───────────────
    This used to fall straight through to `ws://127.0.0.1:8000/ws/deltas`,
    which is correct on the machine running the stack and catastrophically
    wrong everywhere else. Share the console over a tunnel and every guest
    browser tries to open a socket to port 8000 on THEIR OWN computer, where
    nothing is listening.

    Nothing then works, and none of it says why: the delta socket never opens,
    `/api/token` is fine (it is same-origin), but joining the bridge needs the
    Slow Loop, so the guest presses J and simply never joins. Measured with
    the transcript probe against a trycloudflare URL — no PTS, no RTM, no
    toolkit subscribe, mic n/a.

    When the page is not being served from localhost, default to the SAME
    origin it was loaded from. A shared deployment then works with no
    configuration at all, and `NEXT_PUBLIC_SLOW_LOOP_WS` remains the explicit
    override for a Slow Loop that lives somewhere else entirely.

    Note this requires the console tunnel to proxy /ws/deltas and the other
    Slow Loop paths to :8000 — `start.ps1 -Share` does not do that today, so
    it also sets NEXT_PUBLIC_SLOW_LOOP_WS to the backend tunnel and this
    branch is the fallback rather than the primary path.
  */
  if (typeof window !== "undefined") {
    const { hostname, protocol, host } = window.location;
    const isLocal =
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (!isLocal) {
      const scheme = protocol === "https:" ? "wss:" : "ws:";
      const base = `${scheme}//${host}/ws/deltas`;
      return channel ? withChannel(base, channel) : base;
    }
  }

  const defaultUrl = "ws://127.0.0.1:8000/ws/deltas";
  return channel ? withChannel(defaultUrl, channel) : defaultUrl;
}

/** Same approved boundary as the delta socket, expressed as HTTP for ingress. */
export function slowLoopHttpUrl(): string {
  return slowLoopUrl()
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/deltas(\?.*)?$/, "");
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
/**
 * Leave the bridge.
 *
 * `uid` identifies WHO is leaving, and passing it is what stops one person's
 * exit from silencing the room: the route releases that roster row and only
 * stops the Cloud Agent when no participants remain. Omit it to stop the
 * agent unconditionally, which is what `npm run demo stop` wants.
 */
export async function stopAgent(channel: string, uid?: number): Promise<void> {
  try {
    await fetch("/api/stop-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uid ? { channel, uid } : { channel }),
    });
  } catch (error) {
    // Best-effort on the way out. An orphan times out on its own; blocking
    // the operator's exit on a cleanup call would be worse.
    console.warn("[bridge] could not stop the agent", error);
  }
}

/**
 * A participant could not be ISSUED an identity — distinct from a participant
 * whose microphone or RTC join failed.
 *
 * Keeping the two apart is the whole point. Both used to arrive at the same
 * catch and print the same "NO MICROPHONE" banner, and they call for opposite
 * responses from the person reading it: a 409 means pick another role and press
 * J again (nothing is wrong with your hardware), while a genuine mic failure
 * means check the browser's permission prompt.
 */
export class BridgeCredentialError extends Error {
  /*
    Plain fields and explicit assignment, NOT constructor parameter
    properties. The test suite runs these modules under bare `node --test`,
    whose type-stripping loader rejects `constructor(readonly x: T)` outright
    with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — so the shorthand would make this
    module, and anything importing it, untestable outside the bundler.
  */
  readonly status: number;
  /** Roles still free on this channel, when the server named them (409). */
  readonly availableRoles: ParticipantRole[];

  constructor(message: string, status: number, availableRoles: ParticipantRole[]) {
    super(message);
    this.name = "BridgeCredentialError";
    this.status = status;
    this.availableRoles = availableRoles;
  }

  /** A role already live on this bridge — the second joiner's default case. */
  get isRoleConflict(): boolean {
    return this.status === 409;
  }
}

export interface RequestBridgeOptions {
  userId?: string;
  name?: string;
  exclusive?: boolean;
}

export async function requestBridgeCredentials(
  channel: string,
  role: ParticipantRole,
  options?: RequestBridgeOptions,
): Promise<BridgeCredentials> {
  /*
    ── STICKY UID PER TAB, AND WHY TRANSCRIPTS DIE WITHOUT IT ────────────────
    Agora's Conversational AI Engine subscribes to exactly ONE participant,
    fixed when the agent is created (`remote_rtc_uids`). The Roster allocates
    uids sequentially and never releases them, so every reload of this page
    took the NEXT one: 1001, then 1002, then 1003.

    The agent stays pinned to the uid that invited it. From the second reload
    onward the console publishes audio as a participant the agent is not
    listening to — so Agora runs no recogniser on it, emits no transcript, and
    the panel sits on "No speech captured" while the agent is demonstrably
    healthy and mid-conversation with a uid nobody is using any more.

    Measured, not reasoned: a headless run joined as 1002 while the live agent
    was subscribed to 1001. Zero TRANSCRIPT_UPDATED events in 60 seconds, and
    `AUDIO_INPUT_LEVEL_TOO_LOW` from the SDK because nothing consumed the
    stream. Three POSTs to /api/token on one channel returned 1001, 1002, 1003.

    So the tab remembers its uid and asks for that one back. `renew: true` is
    the token route's existing path for exactly this. sessionStorage rather
    than localStorage: a SECOND tab is a second participant and must get its
    own uid, but a reload is the same person and must not.
  */
  let remembered: number | null = null;
  /*
    Keyed by user ID (or role fallback) as well as channel.
  */
  const storageKey = options?.userId
    ? `echo:uid:${channel}:${options.userId}`
    : `echo:uid:${channel}:${role}`;
  try {
    const raw = sessionStorage.getItem(storageKey);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) remembered = parsed;
  } catch {
    // Private mode, or storage disabled. Fall through to a fresh allocation —
    // the first join of a session is correct either way.
  }

  const payload: Record<string, unknown> = {
    channel,
    role,
  };
  if (options?.userId) payload.userId = options.userId;
  if (options?.name) payload.name = options.name;
  if (options?.exclusive !== undefined) payload.exclusive = options.exclusive;
  if (remembered !== null) {
    payload.uid = remembered;
    payload.renew = true;
  }

  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as Partial<BridgeCredentials> & {
    error?: string;
    availableRoles?: ParticipantRole[];
  };
  if (!response.ok) {
    /*
      ── THIS IS NOT A MICROPHONE FAILURE, AND IT USED TO LOOK LIKE ONE ──────
      `/api/token` refuses a role already live on the channel with a 409, which
      is the FIRST thing the second and third person to press J hit, because
      the role dropdown defaults to "DevOps Lead" in every browser.

      That refusal is correct. What was wrong is where it landed: the caller
      wraps this request in the same try/catch as the RTC join, so a 409 —
      along with a 503 for missing env and a 502 for a roster write — raised
      "NO MICROPHONE - you can watch, but the room cannot hear you".

      So the whole room was told their microphone was denied when no mic had
      been touched: nobody had reached `createMicrophoneAudioTrack` yet. People
      then went hunting through browser permissions and OS input settings for a
      fault that was a role collision on the server, and the one piece of
      information that would have ended it in a second - "pick a different
      role, these are free" - was already in the response body and thrown away.

      A distinct error type carries it out intact so the caller can say what
      actually happened. See `openBridge` in `incident-store.tsx`.
    */
    throw new BridgeCredentialError(
      body.error ?? `Token request failed (${response.status})`,
      response.status,
      body.availableRoles ?? [],
    );
  }
  if (!body.appId || !body.rtcToken || !body.rtmToken || !body.uid) {
    throw new BridgeCredentialError("Token response was incomplete", response.status, []);
  }
  // Remember it for the next reload, so the agent's one subscribed uid keeps
  // pointing at this tab.
  try {
    sessionStorage.setItem(storageKey, String(body.uid));
  } catch {
    // Not fatal: without storage the next reload allocates a new uid and the
    // console re-invites, which is the pre-existing behaviour.
  }

  return {
    appId: body.appId,
    rtcToken: body.rtcToken,
    rtmToken: body.rtmToken,
    uid: body.uid,
    role,
    userId: body.userId,
    name: body.name,
    authorized: body.authorized,
  };
}

/**
 * Release this participant's roster row during page teardown.
 *
 * ── WHY A BEACON, AND WHY IT LIVES HERE ─────────────────────────────────────
 * React's unmount cleanup only runs on an orderly teardown. It does NOT run on
 * a hard refresh, a closed tab, a closed laptop or a crash — and those are the
 * cases that were leaving GHOSTS in the roster. A row is released only by an
 * orderly leave and otherwise lives for the full token TTL (one hour), so each
 * abandoned session locked a role for an hour. Reported live: one person on the
 * bridge, all three roles showing as taken, second joiner unable to select any.
 *
 * `sendBeacon` is the only transport that survives unload — a `fetch` issued
 * then is cancelled along with the document, which is precisely why the
 * existing cleanup could never have covered this.
 *
 * It lives in THIS module because Zone 1 egress is confined here by
 * `phase1-evaluation.test.ts`, and the right response to needing another call
 * is to add it here rather than widen that allow-list. The caller registers the
 * `pagehide` listener; only the egress itself is centralised.
 *
 * Best effort by design: it cannot be awaited and it can be dropped, so the
 * server-side takeover in `/api/token` remains the actual guarantee.
 */
export function beaconLeave(channel: string, uid: number): void {
  try {
    navigator.sendBeacon(
      "/api/stop-agent",
      // A Blob so the request carries a JSON content type. A bare string is
      // sent as text/plain and the route would reject the body.
      new Blob([JSON.stringify({ channel, uid })], { type: "application/json" }),
    );
  } catch {
    // Nothing can be done during unload, and the takeover covers it.
  }
}

/**
 * Tell the Roster this participant is still on the bridge.
 *
 * ── WHAT THIS PREVENTS ──────────────────────────────────────────────────────
 * A roster row is only released by an orderly leave and otherwise lives for
 * the full token TTL (one hour), so a refresh, a closed tab or a crash left a
 * GHOST holding a role. Reported live: one person on the bridge, all three
 * roles showing as taken, and the second joiner unable to select any role.
 *
 * `/api/token` now reclaims a role whose holder has not been seen for 90s.
 * This heartbeat is what marks a holder as still present, so that takeover can
 * never evict somebody who is actually talking — `issuedAt` is fixed at join
 * time and cannot tell the two apart.
 *
 * Returns false when the row is gone (released, or reclaimed by someone else).
 * Never throws: a missed beat is harmless, the next one is 30s away, and a
 * heartbeat must never be able to break a live bridge.
 */
export async function heartbeatRoster(
  channel: string,
  uid: number,
): Promise<boolean> {
  try {
    const response = await fetch("/api/roster", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, uid }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { present?: boolean };
    return Boolean(body.present);
  } catch {
    return false;
  }
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
  identity?: { speakerName?: string; speakerUserId?: string },
): Promise<void> {
  const response = await fetch(`${slowLoopHttpUrl()}/observer/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...transcript,
      role,
      speakerName: identity?.speakerName,
      speakerUserId: identity?.speakerUserId,
    }),
  });
  if (!response.ok) throw new Error(`Slow Loop returned HTTP ${response.status}`);
}

/**
 * Fetches the active enterprise session user from /api/auth/me.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function fetchSessionUser(): Promise<UserProfile | null> {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: UserProfile };
    return data.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Persists persona switch to /api/auth/me.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function persistSessionUser(userId: string): Promise<UserProfile | null> {
  try {
    const res = await fetch("/api/auth/me", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: UserProfile };
    return data.user ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch all active participants on the channel for the War Room Roster.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function fetchRosterParticipants(channel: string): Promise<RosterParticipant[]> {
  try {
    const res = await fetch(`/api/roster?channel=${encodeURIComponent(channel)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { participants?: RosterParticipant[] };
    return data.participants ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch the automated incident post-mortem report from the Slow Loop.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function fetchPostMortem(): Promise<PostMortemResponse | null> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/incident/postmortem`);
    if (!res.ok) return null;
    return (await res.json()) as PostMortemResponse;
  } catch {
    return null;
  }
}

/**
 * Execute an on-demand read-only telemetry probe against the Slow Loop.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function triggerTelemetryProbe(
  entity: string,
  metric?: string,
  targetEntityId?: string,
): Promise<{ reading: TelemetryReading; claim: Claim } | null> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/telemetry/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entity,
        metric: metric || null,
        target_entity_id: targetEntityId || null,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { reading: TelemetryReading; claim: Claim };
    return data;
  } catch {
    return null;
  }
}

export interface HistoricalIncidentResult {
  archiveId: string;
  channel: string;
  title: string;
  summary: string;
  markdown: string;
  keyClaims: string[];
  score: number;
}

/**
 * Search historical incident postmortems using semantic vector search.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function searchHistoricalIncidents(
  query: string,
  topK: number = 6,
  scoreThreshold: number = 0.25,
): Promise<HistoricalIncidentResult[]> {
  try {
    const res = await fetch(
      `${slowLoopHttpUrl()}/incident/search?query=${encodeURIComponent(query)}&top_k=${topK}&score_threshold=${scoreThreshold}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []) as HistoricalIncidentResult[];
  } catch {
    return [];
  }
}

/**
 * Fetch all enterprise project workspaces and connector statuses.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function fetchProjects(): Promise<ProjectWorkspace[]> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/projects`);
    if (!res.ok) return [];
    const data = (await res.json()) as { projects?: ProjectWorkspace[] };
    return data.projects ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch complete workspace details for a specific project.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function fetchProjectDetails(projectId: string): Promise<ProjectWorkspace | null> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/projects/${encodeURIComponent(projectId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { project?: ProjectWorkspace };
    return data.project ?? null;
  } catch {
    return null;
  }
}

/**
 * Save or update connector credentials for a project.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function saveConnectorConfig(
  projectId: string,
  payload: {
    provider: ConnectorProvider | string;
    name?: string;
    endpoint?: string;
    secret?: string;
    apiKey?: string;
    authHeader?: string;
    region?: string;
    serviceFilter?: string;
  },
): Promise<ConnectorConfig | null> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/projects/${encodeURIComponent(projectId)}/connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { connector?: ConnectorConfig };
    return data.connector ?? null;
  } catch {
    return null;
  }
}

/**
 * Run active health and latency ping test against a project connector.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function testConnectorConnection(
  projectId: string,
  payload: {
    provider: ConnectorProvider | string;
    endpoint?: string;
    secret?: string;
    region?: string;
    serviceFilter?: string;
  },
): Promise<{
  status: ConnectorStatus;
  latencyMs: number;
  message: string;
  metricsDiscovered?: number;
  testedAt?: number;
}> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/projects/${encodeURIComponent(projectId)}/connectors/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return {
        status: "ERROR",
        latencyMs: 0,
        message: `HTTP ${res.status}: Connection test failed`,
      };
    }
    return (await res.json()) as {
      status: ConnectorStatus;
      latencyMs: number;
      message: string;
      metricsDiscovered?: number;
      testedAt?: number;
    };
  } catch (err) {
    return {
      status: "ERROR",
      latencyMs: 0,
      message: String(err),
    };
  }
}

/**
 * Spin up a new incident war room channel for a project.
 * Zone 1 egress is confined to this module (v6 §10.1).
 */
export async function createProjectIncident(
  projectId: string,
  payload: {
    title: string;
    severity: number;
    channel: string;
  },
): Promise<IncidentChannelSummary | null> {
  try {
    const res = await fetch(`${slowLoopHttpUrl()}/projects/${encodeURIComponent(projectId)}/incidents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { incident?: IncidentChannelSummary };
    return data.incident ?? null;
  } catch {
    return null;
  }
}



