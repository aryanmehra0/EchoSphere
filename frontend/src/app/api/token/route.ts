import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import {
  mintTokens,
  TOKEN_TTL_SECONDS,
} from "@/lib/server/agora-tokens";
import {
  allocateHumanUid,
  getRoster,
  isAuthorizedRole,
  OBSERVER_UID,
  putEntry,
  releaseEntry,
  RosterWriteError,
  type ParticipantKind,
} from "@/lib/server/roster";
import type { ParticipantRole } from "@/lib/types";

/**
 * POST /api/token — v6 W1, step 2–6.
 *
 * ── THE ORDERING IS THE FEATURE ─────────────────────────────────────────────
 *   1. allocate a UID
 *   2. mint the tokens
 *   3. WRITE THE ROSTER AND WAIT FOR THE ACK
 *   4. only then return the tokens
 *
 * If step 3 fails, step 4 never happens and the participant does not join.
 * Joining unattributably is strictly worse than not joining: an unknown UID on
 * the channel produces claims the Ledger cannot source, and an unsourced claim
 * violates §6 Rule 1 at the point of ingestion, where nothing downstream can
 * repair it.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Route handlers are not cached by default in Next 16, which is what we want —
 * every call mints a fresh, time-boxed credential.
 */

const VALID_ROLES: ReadonlySet<string> = new Set<ParticipantRole>([
  "DevOps Lead",
  "Support Engineer",
  "Database Admin",
]);

interface TokenRequest {
  channel?: string;
  role?: string;
  /** Renewal for an existing member — reuses the UID (v6 W7). */
  uid?: number;
  renew?: boolean;
  kind?: ParticipantKind;
}

export async function POST(request: Request) {
  let body: TokenRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const channel = body.channel?.trim();
  if (!channel) {
    return NextResponse.json({ error: "channel is required" }, { status: 400 });
  }

  const role = body.role?.trim();
  if (!role || !VALID_ROLES.has(role)) {
    return NextResponse.json(
      {
        error: `role must be one of: ${[...VALID_ROLES].join(", ")}`,
        // Echo is excluded deliberately — a human may never claim the agent's
        // identity, because `kind: "agent"` drives the self-audio exclusion.
      },
      { status: 400 },
    );
  }
  const participantRole = role as ParticipantRole;

  const kind: ParticipantKind = body.kind === "observer" ? "observer" : "human";

  try {
    /*
      ── ONE ROLE, ONE PERSON ────────────────────────────────────────────────
      The console's role dropdown defaults to "DevOps Lead" in EVERY browser
      (`BridgeControls.tsx`), so three people who just press J all arrive as
      DevOps Lead. Nothing rejected that, and the consequences are not
      cosmetic:

        - The Ledger attributes claims by role, so "DevOps reported X" and
          "DevOps reported not-X" become one person contradicting themselves.
          Echo then interrupts the room to point that out, which is the
          contradiction engine working perfectly on garbage input.
        - `isAuthorizedRole("DevOps Lead")` is true, so ALL THREE would hold
          CRITICAL approval authority — the one thing §10.2 exists to gate.

      A role already live on this channel is therefore refused, with the
      remaining roles named so the joiner can pick one. This is the same
      fail-closed posture as the rest of the route: no token is issued for a
      participant who cannot be attributed distinctly.

      Renewal is exempt — it is the SAME person re-issuing a token for a uid
      they already hold, and `delta-socket.ts` keys its remembered uid by role
      precisely so a role change gets a fresh uid instead of renewing.

      Expired rows do not block: `allocateHumanUid` reclaims them, and a
      participant whose token has expired is no longer on the bridge.
    */
    if (kind === "human" && !body.renew) {
      const now = Date.now();
      const live = (await getRoster(channel)).filter(
        (e) => e.kind === "human" && e.expiresAt > now,
      );
      const taken = live.find((e) => e.role === participantRole);

      /*
        ── A ROLE HELD BY SOMEBODY WHO IS NOT HERE MUST BE RECLAIMABLE ──────
        Reported live: one person joined as DevOps Lead and a second could not
        select ANY role - the console showed all three as taken while only one
        human was on the bridge.

        The roster had three live rows (1001 Support Engineer, 1002 DevOps
        Lead, 1003 Database Admin) left by earlier sessions. A row is only
        released by an orderly leave (`/api/stop-agent` with a uid), so a
        refresh, a closed laptop, a crashed tab or a restarted dev server
        leaves a GHOST holding a role for the FULL TOKEN TTL - one hour.

        "Someone must leave first" is then advice nobody can act on: the
        holder is already gone and cannot leave again. That turned a stale
        row into an hour-long lockout of the whole bridge.

        So a role whose holder is not actually in the RTC channel is taken
        over rather than refused. `EXCLUSIVE_GRACE_MS` is the only thing
        protecting a genuine double-join, and it is deliberately short: a real
        participant re-asserts their row on every token renewal, while a ghost
        never touches it again.

        This does NOT weaken the exclusivity invariant the 409 exists for. A
        role still cannot be held by two people at once - the takeover DELETES
        the previous row, so `getObserverView` still reports exactly one uid
        per role and attribution stays unambiguous.
      */
      /*
        ── WHY THIS MEASURES A HEARTBEAT, NOT THE ROW'S AGE ────────────────
        The obvious test is "is `issuedAt` old?", and it is WRONG here:
        nothing refreshes a human's roster row. `touchExpiry` is only ever
        called for the agent (`/api/agent-events`), so a person who joined
        and has been talking for ten minutes has an `issuedAt` ten minutes
        old - indistinguishable by age from a ghost.

        Taking over on age alone would therefore evict LIVE participants,
        which is far worse than the lockout being fixed: two people would end
        up sharing a role and the Ledger would attribute their claims to one
        source.

        So the console heartbeats its row (`PATCH /api/roster`) while it is on
        the bridge, and the takeover asks how long ago that row was last SEEN.
        A live participant is seen every 30s; a ghost is never seen again.
        `lastSeen` falls back to `issuedAt` for a row written before this
        existed, so an old row is takeable rather than permanently stuck.
      */
      const EXCLUSIVE_GRACE_MS = 90_000;
      const lastSeen = taken ? (taken.lastSeen ?? taken.issuedAt) : 0;
      const staleHold = taken && Date.now() - lastSeen > EXCLUSIVE_GRACE_MS;

      if (taken && staleHold) {
        // Reclaim it. The old uid's row goes, so the role has exactly one
        // holder at every instant.
        await releaseEntry(channel, taken.uid);
        console.info(
          `[/api/token] ${participantRole} reclaimed from uid ${taken.uid} ` +
            `(row was ${Math.round((Date.now() - taken.issuedAt) / 1000)}s old ` +
            `and never released) — treating it as a stale hold`,
        );
      } else if (taken) {
        const free = [...VALID_ROLES].filter(
          (r) => !live.some((e) => e.role === r),
        );
        return NextResponse.json(
          {
            error:
              `${participantRole} was claimed moments ago (uid ${taken.uid}). ` +
              (free.length
                ? `Pick a different role: ${free.join(", ")}.`
                : "Try again in a minute — a stale claim is released automatically."),
            role: participantRole,
            availableRoles: free,
          },
          { status: 409 },
        );
      }
    }

    // The Observer holds a fixed UID; humans get the next free slot. On renewal
    // the caller supplies its existing UID so the channel identity is stable
    // across the token swap — a renewal that changed UID would look like a new
    // participant to the Observer and orphan every prior claim.
    const uid = body.renew && body.uid
      ? body.uid
      : kind === "observer"
        ? OBSERVER_UID
        : allocateHumanUid(channel);

    const tokens = mintTokens(channel, uid, {
      // Least privilege: the Observer subscribes, it never publishes.
      publisher: kind !== "observer",
    });

    // ── Step 3. Fail closed. ──────────────────────────────────────────────
    await putEntry({
      channel,
      uid,
      role: participantRole,
      kind,
      authorized: isAuthorizedRole(participantRole),
      issuedAt: Date.now(),
      // Seen NOW, by definition — this is the join. Without seeding it the
      // row would look 90s-stale to the takeover the moment it was written,
      // and a second joiner could evict somebody who just arrived.
      lastSeen: Date.now(),
      expiresAt: tokens.expiresAt,
    });

    // ── Step 4. Only now. ─────────────────────────────────────────────────
    return NextResponse.json({
      // The App ID is NOT a secret — it ships inside every Agora client bundle,
      // and `.env.local.example` says so explicitly: the CERTIFICATE is the
      // secret. Returning it here means one call gives a joiner everything it
      // needs, which is what lets a plain static page (or the S1 client wiring)
      // join without reading env at build time.
      appId: serverEnv.agoraAppId,
      rtcToken: tokens.rtcToken,
      rtmToken: tokens.rtmToken,
      uid,
      channel,
      role: participantRole,
      authorized: isAuthorizedRole(participantRole),
      expiresAt: tokens.expiresAt,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    if (error instanceof MissingEnvError) {
      // A precise, actionable message. The most likely cause by far is a
      // missing .env.local, and a generic 500 sends people hunting in Agora's
      // console instead of their own filesystem.
      return NextResponse.json(
        { error: error.message, hint: "See frontend/.env.local.example" },
        { status: 503 },
      );
    }

    if (error instanceof RosterWriteError) {
      return NextResponse.json(
        {
          error: `Roster write failed: ${error.message}`,
          hint: "Token issuance fails closed so nobody joins unattributably.",
        },
        { status: 502 },
      );
    }

    console.error("[/api/token] unexpected failure", error);
    return NextResponse.json({ error: "Token issuance failed" }, { status: 500 });
  }
}
