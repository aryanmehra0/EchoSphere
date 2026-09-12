import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { serverEnv } from "@/lib/server/env";

/**
 * Attaches `AGENT_TOOL_SECRET` to every browser request this console proxies
 * to the Slow Loop, before `next.config.ts`'s `rewrites()` forwards it.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * `backend/app/web/middleware.py`'s tunnel gate used to treat every request
 * whose `Host` header said "localhost" as exempt from needing a secret — a
 * header the caller fully controls, so a remote attacker could simply send
 * that value and bypass it. The fix replaces that with a check for whether
 * the request actually transited Cloudflare's tunnel, which means EVERY
 * request that goes through the tunnel now needs the secret — including
 * this console's own proxied calls from a remote guest's browser (a local
 * developer's browser talking straight to `127.0.0.1:8000` is unaffected;
 * that path never touches Cloudflare at all).
 *
 * The browser itself must never hold `AGENT_TOOL_SECRET` — it would be
 * sitting in the page's network requests for anyone to read. So this runs
 * SERVER-SIDE, in the one hop between the browser and the Slow Loop that
 * both (a) already exists for every one of these paths (`next.config.ts`'s
 * `rewrites()`) and (b) never inspects or decides anything about the
 * request's content — it only forwards bytes, plus this one header. That is
 * a materially different thing from the "second service in the
 * authorization path" `/approval/redeem` is documented to avoid: no
 * authorization decision is made or re-implemented here.
 *
 * Skipped entirely when no secret is configured, matching the backend's own
 * fail-closed design for that case — an unset secret already refuses every
 * remote request on the Python side, and attaching an empty header here
 * would do nothing but add noise.
 *
 * ── WHY THE MATCHER LIST IS A LITERAL, NOT AN IMPORT ────────────────────
 * Next.js extracts `config.matcher` by statically parsing this file at
 * build time, without executing it — an imported value (e.g. reusing
 * `next.config.ts`'s own `SLOW_LOOP_PATHS` array) is not guaranteed to
 * survive that analysis. Kept in step with `next.config.ts` by hand; a path
 * added to one and not the other means this attaches no header for it, and
 * that request then behaves exactly as it did before this file existed.
 */
export function proxy(request: NextRequest) {
  const secret = serverEnv.agentToolSecret;
  if (!secret) return NextResponse.next();

  const headers = new Headers(request.headers);
  headers.set("x-echo-tool-token", secret);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/observer/:path*",
    "/ws/deltas",
    "/agent/:path*",
    "/bridge/:path*",
    "/tools/:path*",
    "/approval/:path*",
    "/privacy/:path*",
    "/incident/:path*",
    "/health",
    "/health/:path*",
    "/audit",
    "/query_incident_state",
  ],
};
