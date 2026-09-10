import { NextResponse } from "next/server";

import { getObserverView, touchSeen } from "@/lib/server/roster";

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
 * ── WHY THE BROWSER NEEDS THIS AT ALL ──────────────────────────────────────
 * Echo subscribes to `["*"]`, so Agora's transcript stream carries EVERY
 * speaker's finished turn to every console. One console can therefore minute
 * the whole room — which is what lets colleagues join the bridge from any
 * Agora client with no console, no tunnel and no setup of their own.
 *
 * But a transcript arrives carrying a uid and nothing else. Attribution is the
 * product, and filing Support's sentence under DevOps's name is worse than
 * dropping it: §6.2 Rule 1 catches an unsourced claim and nothing catches a
 * mis-sourced one. The Roster is the only component that has ever known
 * uid → role, and it lives in Zone 2 — so the browser has to ask.
 *
 * ── WHY THIS IS SAFE TO EXPOSE ─────────────────────────────────────────────
 * It returns uid → role and the agent-exclusion list. No tokens, no
 * credentials, no App Certificate — nothing a participant on the bridge does
 * not already know by being on it. `getObserverView` is the same read the
 * Observer performs (§4.3), so there is one definition of "who is here"
 * rather than a second one that can drift.
 *
 * Roles are returned as STRING keys, because that is what JSON does to numeric
 * object keys. The client parses them back; asserting that is a test, because
 * a uid silently arriving as `"1001"` and being looked up as `1001` fails by
 * skipping every utterance rather than by throwing.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const channel = new URL(request.url).searchParams.get("channel")?.trim();

  if (!channel) {
    return NextResponse.json({ error: "channel is required" }, { status: 400 });
  }

  try {
    const { roles, exclude } = await getObserverView(channel);
    return NextResponse.json({ channel, roles, exclude });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
