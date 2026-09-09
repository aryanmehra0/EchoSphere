import { NextResponse } from "next/server";

import { getObserverView, getRoster } from "@/lib/server/roster";

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
