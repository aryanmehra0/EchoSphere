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
import { getSessionUser } from "@/lib/server/auth";

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
  "Incident Commander",
  "Communications Lead",
  "DevOps Lead",
  "Site Reliability Engineer",
  "Database Admin",
  "Backend Engineer",
  "Security Engineer",
  "Network Engineer",
  "Support Engineer",
  "Observer",
]);

interface TokenRequest {
  channel?: string;
  role?: string;
  /** Renewal for an existing member — reuses the UID (v6 W7). */
  uid?: number;
  renew?: boolean;
  kind?: ParticipantKind;
  userId?: string;
  name?: string;
  exclusive?: boolean;
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

  const sessionUser = await getSessionUser(request);
  const effectiveUserId = body.userId || sessionUser.id;
  const effectiveName = body.name || sessionUser.name;

  const kind: ParticipantKind = body.kind === "observer" ? "observer" : "human";

  try {
    if (kind === "human" && !body.renew) {
      const now = Date.now();
      const live = (await getRoster(channel)).filter(
        (e) => e.kind === "human" && e.expiresAt > now,
      );

      // Explicit exclusive role check (e.g. if requested or for single-lead constraint)
      if (body.exclusive) {
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

      // In multi-user mode: if a user is already connected on this channel, reconnect/renew
      if (effectiveUserId) {
        const existing = live.find((e) => e.userId === effectiveUserId);
        if (existing) {
          body.uid = existing.uid;
          body.renew = true;
        }
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

    const isAuth = isAuthorizedRole(participantRole);

    // ── Step 3. Fail closed. ──────────────────────────────────────────────
    await putEntry({
      channel,
      uid,
      role: participantRole,
      kind,
      authorized: isAuth,
      issuedAt: Date.now(),
      expiresAt: tokens.expiresAt,
      userId: effectiveUserId,
      name: effectiveName,
      permissions: isAuth
        ? ["APPROVE_CRITICAL_ACTIONS", "SPEAK_ON_BRIDGE", "MINT_TIMELINE_DECISIONS"]
        : ["SPEAK_ON_BRIDGE"],
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
      userId: effectiveUserId,
      name: effectiveName,
      authorized: isAuth,
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
