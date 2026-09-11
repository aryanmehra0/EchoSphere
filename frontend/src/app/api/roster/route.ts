import { NextResponse } from "next/server";

import { getObserverView, getRoster, touchSeen } from "@/lib/server/roster";

/**
 * PATCH /api/roster — "I am still on this bridge."
 *
 * ── WHY PRESENCE HAD TO BECOME EXPLICIT ─────────────────────────────────────
 * Nothing refreshed a human's roster row, and a row is only released by an
 * orderly leave. So a refresh, a closed tab or a crashed browser left a GHOST
 * holding a role for the full token TTL — one hour.
 *
 * Reported live: one person joined as DevOps Lead and the second joiner could
 * not select ANY role, because the roster listed all three as taken while only
 * one human was actually present.
 *
 * `/api/token` reclaims a role whose holder has not been seen for 90s, and
 * this is what "seen" means. Without it that takeover would have to guess from
 * `issuedAt`, which is fixed at join time and would evict people who are
 * still talking.
 *
 * Deliberately tiny and idempotent: it carries no credential, changes no
 * token lifetime, and a lost beat costs nothing because the next one is 30s
 * away.
 */
export async function PATCH(request: Request): Promise<NextResponse> {
  let body: { channel?: string; uid?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const channel = body.channel?.trim();
  const uid = Number(body.uid);
  if (!channel || !Number.isInteger(uid) || uid <= 0) {
    return NextResponse.json({ error: "channel and uid are required" }, { status: 400 });
  }

  // `false` means the row is gone — released by a leave, or reclaimed by
  // somebody else. Not an error: the caller is stale, and 200 with
  // `present: false` lets it find that out without an exception path.
  const present = await touchSeen(channel, uid);
  return NextResponse.json({ channel, uid, present });
}

/**
 * GET /api/roster?channel=inc-4417 — who is on this bridge, and as what role?
 *
 * Returns uid → role, exclude list, and full participant details (name, userId, permissions).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const channel = new URL(request.url).searchParams.get("channel")?.trim();

  if (!channel) {
    return NextResponse.json({ error: "channel is required" }, { status: 400 });
  }

  try {
    const [{ roles, exclude }, all] = await Promise.all([
      getObserverView(channel),
      getRoster(channel),
    ]);
    const participants = all.map((p) => ({
      uid: p.uid,
      role: p.role,
      kind: p.kind,
      authorized: p.authorized,
      issuedAt: p.issuedAt,
      userId: p.userId,
      name: p.name,
      permissions: p.permissions,
    }));
    return NextResponse.json({ channel, roles, exclude, participants });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
