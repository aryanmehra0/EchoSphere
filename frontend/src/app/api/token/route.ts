import { NextResponse } from "next/server";

import { MissingEnvError } from "@/lib/server/env";
import {
  mintTokens,
  TOKEN_TTL_SECONDS,
} from "@/lib/server/agora-tokens";
import {
  allocateHumanUid,
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
