import type { ParticipantRole, UserPermission } from "@/lib/types";

/**
 * The Roster — the shared identity table both loops read (v6 §4.2, closes G3).
 *
 * ── THE ORDERING RULE ───────────────────────────────────────────────────────
 * The roster write is acknowledged BEFORE the token is handed to the browser.
 * If the write fails, token issuance fails and the participant does not join.
 *
 * That single ordering is what turns "every UID on the channel has a known
 * role" from a hope into an invariant. Downstream it is what lets the Observer
 * treat an unknown UID as an ERROR WORTH LOGGING rather than a routine case to
 * guess at — and guessing is precisely what v5 did, which is why an
 * unattributable claim could reach the Ledger.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module is deliberately NOT marked `server-only`: it holds no secrets,
 * and the reducer-style purity means the S2 tests can drive it directly.
 *
 * ── IMPLEMENTATION NOTE ─────────────────────────────────────────────────────
 * v6 puts the canonical Roster in the Python process, because the Observer
 * needs it in-process on the audio hot path. Until that exists (S2), this is
 * an in-memory store behind the same async interface the HTTP client will
 * have. When `ROSTER_SERVICE_URL` is set, `putEntry` proxies to Python and
 * this map becomes a write-through cache — no call site changes.
 *
 * The in-memory map does NOT survive a dev-server reload, which is correct:
 * a restarted Next.js has no business claiming to know who is on a channel it
 * has lost track of.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type ParticipantKind = "human" | "agent" | "observer";

export interface RosterEntry {
  channel: string;
  uid: number;
  role: ParticipantRole;
  kind: ParticipantKind;
  /** May this role approve CRITICAL actions? See v6 §10.2. */
  authorized: boolean;
  issuedAt: number;
  expiresAt: number;
  userId?: string;
  name?: string;
  permissions?: UserPermission[];
  /**
   * When this participant last proved it is still on the bridge.
   *
   * ── WHY `issuedAt` COULD NOT ANSWER THIS ────────────────────────────────
   * Nothing refreshes a human's row: `touchExpiry` is called only for the
   * agent. So `issuedAt` says when somebody joined and NOTHING about whether
   * they are still here, and a row lives for the full token TTL (one hour)
   * unless an orderly leave releases it.
   *
   * A refresh, a closed tab or a crashed browser therefore left a GHOST
   * holding a role for an hour. Reported live: one person on the bridge,
   * every role showing as taken, and the second joiner unable to select any
   * role at all.
   *
   * The console heartbeats this while it is joined, so "last seen" separates
   * a live participant from an abandoned row - which is what lets
   * `/api/token` reclaim one without ever evicting somebody who is actually
   * talking.
   *
   * Optional: rows written before this existed have none, and the readers
   * fall back to `issuedAt` so an old row is takeable rather than stuck.
   */
  lastSeen?: number;
}

/** Thrown when the roster write fails — callers MUST NOT issue a token. */
export class RosterWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterWriteError";
  }
}

/**
 * UID allocation.
 *
 * Humans occupy 1000–8999, Echo is pinned at 9000, and the Observer at 9001.
 * Fixed agent UIDs matter: the Observer's self-audio exclusion set is built
 * from `kind: "agent"`, and a stable, reserved number makes that set trivially
 * verifiable in the S2 test ("zero claims attributed to uid 9000").
 */
export const AGENT_UID = 9000;
export const OBSERVER_UID = 9001;

const HUMAN_UID_MIN = 1000;
const HUMAN_UID_MAX = 8999;

/**
 * Which roles may approve a CRITICAL action.
 *
 * This is an allow-list, not a deny-list: a role that is not named here cannot
 * approve, so adding a participant type can never accidentally grant authority.
 */
const AUTHORIZED_ROLES: ReadonlySet<ParticipantRole> = new Set<ParticipantRole>([
  "Incident Commander",
  "DevOps Lead",
]);

export function isAuthorizedRole(role: ParticipantRole): boolean {
  return AUTHORIZED_ROLES.has(role);
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

/** channel → uid → entry */
const store = new Map<string, Map<number, RosterEntry>>();

function channelMap(channel: string): Map<number, RosterEntry> {
  let m = store.get(channel);
  if (!m) {
    m = new Map();
    store.set(channel, m);
  }
  return m;
}

/**
 * Allocate a human UID that is free ACROSS EVERY CHANNEL.
 *
 * ── WHY THIS IS NOT PER-CHANNEL, THOUGH THE ROSTER IS ──────────────────────
 * It used to scan only `channelMap(channel)`, so each new channel restarted at
 * 1001. Two people on two different channels were both handed uid 1001, and
 * the second one to join was thrown out of RTM:
 *
 *     NO TRANSCRIPTS — RTM is unavailable ...
 *     error code -10027 · the user ID is already in use
 *
 * RTM identity is app-wide. `agora-tokens.ts` builds the RTM token from
 * `String(uid)` with no channel in it, and Agora's RTM service allows one
 * login per user id per app — a second login with the same id evicts or
 * refuses the first. Channel scoping is an RTC concept; RTM does not share it.
 *
 * The visible damage is worse than a name clash. RTM carries the transcript
 * feed (the agent is started with `data_channel: "rtm"`), so the losing
 * browser gets no transcripts at all, and because both consoles are publishing
 * audio as the same participant their voices collide in the channel too —
 * which is exactly the "I can't hear my friend" half of the report.
 *
 * Still sequential and still starting at 1001, so the first person on the
 * first channel is 1001 and the demo narrates the same way it always did.
 */
export function allocateHumanUid(channel: string): number {
  /*
    Expired rows are reclaimed first.

    Nothing ever removed a roster entry, and uids are now allocated across ALL
    channels (an RTM identity is app-wide), so the 1000-8999 range is a shared,
    monotonically shrinking pool. A long-lived server would eventually hand out
    "No free UID" to a bridge with three people on it.

    A row past its token expiry cannot correspond to anyone still connected —
    the token they hold has expired too — so the uid is free to reissue.
  */
  const now = Date.now();
  for (const entries of store.values()) {
    for (const [uid, entry] of [...entries]) {
      if (entry.expiresAt <= now) entries.delete(uid);
    }
  }

  const taken = new Set<number>();
  for (const entries of store.values()) {
    for (const uid of entries.keys()) taken.add(uid);
  }

  for (let uid = HUMAN_UID_MIN + 1; uid <= HUMAN_UID_MAX; uid++) {
    if (!taken.has(uid)) return uid;
  }
  throw new RosterWriteError(`No free UID left (channel ${channel})`);
}

/**
 * Write an entry and acknowledge it. Callers must `await` this and must not
 * issue a token if it rejects.
 */
export async function putEntry(entry: RosterEntry): Promise<RosterEntry> {
  if (!entry.channel?.trim()) {
    throw new RosterWriteError("Roster entry has no channel");
  }
  if (!Number.isInteger(entry.uid) || entry.uid <= 0) {
    throw new RosterWriteError(`Invalid UID: ${entry.uid}`);
  }
  if (!entry.role?.trim()) {
    throw new RosterWriteError(`UID ${entry.uid} has no role`);
  }

  // S2: when the Python Roster exists, PUT here and fail closed on non-2xx.
  channelMap(entry.channel).set(entry.uid, entry);
  return entry;
}

export async function getRoster(channel: string): Promise<RosterEntry[]> {
  const now = Date.now();
  const map = channelMap(channel);
  for (const [uid, entry] of [...map.entries()]) {
    if (entry.expiresAt <= now) {
      map.delete(uid);
    }
  }
  return [...map.values()];
}

export async function getEntry(
  channel: string,
  uid: number,
): Promise<RosterEntry | null> {
  return channelMap(channel).get(uid) ?? null;
}

/**
 * Remove one participant, and report how many humans remain.
 *
 * ── WHY LEAVING HAD TO BECOME EXPLICIT ──────────────────────────────────────
 * Nothing ever removed a roster row. `allocateHumanUid` reclaims EXPIRED ones,
 * but a token lives an hour, so for that hour a person who has left still
 * holds their uid and — now that roles are exclusive — their role. The second
 * person to use a laptop would be told "DevOps Lead is already on this bridge"
 * by a ghost.
 *
 * The returned count is what makes shared occupancy decidable. Any one person
 * pressing Q used to call `/api/stop-agent`, which is channel-wide: on a
 * three-person bridge the first person to leave silenced Echo for the two
 * still talking. The caller can now ask "am I the last one out?" instead of
 * assuming it.
 *
 * `humansRemaining` counts LIVE humans only. The Observer and the agent hold
 * their own reserved uids and are not participants in this sense; an expired
 * row is somebody who is already gone.
 */
export async function releaseEntry(
  channel: string,
  uid: number,
): Promise<{ released: boolean; humansRemaining: number }> {
  const entries = channelMap(channel);
  const released = entries.delete(uid);

  const now = Date.now();
  let humansRemaining = 0;
  for (const entry of entries.values()) {
    if (entry.kind === "human" && entry.expiresAt > now) humansRemaining += 1;
  }

  return { released, humansRemaining };
}

/**
 * The uid→role map and agent exclusion set the Observer needs (v6 §4.3).
 *
 * Returned together because they are read together on the audio hot path, and
 * a caller that has one but not the other is a caller that will mis-attribute
 * Echo's own speech.
 */
export async function getObserverView(channel: string): Promise<{
  roles: Record<number, ParticipantRole>;
  exclude: number[];
}> {
  const entries = await getRoster(channel);
  const roles: Record<number, ParticipantRole> = {};
  const exclude: number[] = [];

  for (const e of entries) {
    roles[e.uid] = e.role;
    // Echo's own audio, and the Observer if it ever publishes. Excluding by
    // KIND rather than by hardcoded uid means a second agent is handled too.
    if (e.kind === "agent" || e.kind === "observer") exclude.push(e.uid);
  }

  return { roles, exclude };
}

/**
 * Mark a participant as still present. Returns false when the row is gone.
 *
 * Separate from `touchExpiry` on purpose: that extends a row's LIFETIME after
 * a token renewal, which is a credential concern. This records PRESENCE, and
 * is what `/api/token` reads to tell a live holder from an abandoned one
 * without touching how long the token is valid for.
 */
export async function touchSeen(
  channel: string,
  uid: number,
  at: number = Date.now(),
): Promise<boolean> {
  const entry = channelMap(channel).get(uid);
  if (!entry) return false;
  channelMap(channel).set(uid, { ...entry, lastSeen: at });
  return true;
}

/** Extend an entry's lifetime after a token renewal (v6 W7). */
export async function touchExpiry(
  channel: string,
  uid: number,
  expiresAt: number,
): Promise<RosterEntry> {
  const entry = channelMap(channel).get(uid);
  if (!entry) {
    throw new RosterWriteError(`UID ${uid} not on channel ${channel}`);
  }
  const next = { ...entry, expiresAt };
  channelMap(channel).set(uid, next);
  return next;
}

/** Test seam. Never called by application code. */
export function __resetRoster(): void {
  store.clear();
}
