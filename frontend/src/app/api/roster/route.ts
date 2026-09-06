import { NextResponse } from "next/server";

import { getObserverView } from "@/lib/server/roster";

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
