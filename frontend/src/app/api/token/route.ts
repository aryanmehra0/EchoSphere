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
      if (taken) {
        const free = [...VALID_ROLES].filter(
          (r) => !live.some((e) => e.role === r),
        );
        return NextResponse.json(
          {
            error:
              `${participantRole} is already on this bridge (uid ${taken.uid}). ` +
              (free.length
                ? `Pick a different role: ${free.join(", ")}.`
                : "Every role is taken — someone must leave first."),
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
