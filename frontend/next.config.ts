import type { NextConfig } from "next";

/**
 * ── WHY `allowedDevOrigins` IS HERE ─────────────────────────────────────────
 *
 * Next 16's dev server refuses cross-origin requests for its own assets. Serve
 * the console through a tunnel and the guest's browser gets the HTML — and
 * then a 403 on EVERY `/_next/static/chunks/*.js` file:
 *
 *     [http 403] .../_next/static/chunks/src_20aci8j._.js
 *     [http 403] .../_next/static/chunks/node_modules_1ge24l_._.js
 *
 * React therefore never boots. The page renders its server-side HTML, looks
 * completely normal, and does nothing at all: pressing J runs no handler, the
 * delta socket never opens, the status bar sits on BRIDGE IDLE / STANDBY.
 * From the guest's side it is indistinguishable from "cannot join the bridge",
 * and no error names the cause — the 403s are only visible in DevTools.
 *
 * Measured with `scripts/_guest.mjs` against a live trycloudflare URL.
 *
 * A wildcard is safe here in a way it would not be in production: this only
 * affects `next dev`, and the whole point of `start.ps1 -Share` is that the
 * console is deliberately public for the duration of a demo. Pinning exact
 * hostnames is impossible anyway — a quick tunnel gets a new random name on
 * every run, so a fixed list would be stale before it was useful.
 */

/**
 * Where the Slow Loop actually listens. Server-side only — this is the
 * rewrite DESTINATION, so it is resolved by Next.js on the host machine and
 * `127.0.0.1` is correct here in a way it never is in the browser.
 */
const SLOW_LOOP_ORIGIN =
  process.env.SLOW_LOOP_ORIGIN?.trim() || "http://127.0.0.1:8000";

/**
 * Every path the Slow Loop owns, taken from the routers in
 * `backend/app/web/routers/` (`APIRouter(prefix=...)` plus the bare ones).
 *
 * Listed EXPLICITLY rather than proxying `/:path*`, because a catch-all would
 * shadow the console's own `/api/*` routes and its `/_next/*` assets — the
 * token minting and the roster live in Next.js and must NOT be forwarded.
 *
 * Kept in step BY HAND with `src/proxy.ts`'s `config.matcher` — that file
 * attaches `AGENT_TOOL_SECRET` to every request proxied through this list,
 * and a path added here without a matching entry there is silently
 * unauthenticated for remote traffic.
 */
const SLOW_LOOP_PATHS = [
  "/observer/:path*",       // ingest.py + audio_stream.py — the transcript ingress
  "/ws/deltas",             // deltas.py  — the delta socket
  "/agent/:path*",          // agent.py
  "/bridge/:path*",         // bridge.py
  "/tools/:path*",          // tools.py
  "/approval/:path*",       // approval.py
  "/privacy/:path*",        // ops.py
  "/incident/:path*",       // ops.py — /incident/reset
  "/health",                // ops.py
  "/health/:path*",         // ops.py — /health/model
  "/audit",                 // approval.py
  "/query_incident_state",  // tools.py
];

const nextConfig: NextConfig = {
  /*
    Both forms. A quick tunnel serves from `<random>.trycloudflare.com`, and
    the apex is listed alongside it so a bare-domain variant is not refused.
    The reasoning is in the block comment above; it is not repeated here.

    A tunnel is a real hole while it is open. `AGENT_TOOL_SECRET` guards the
    Slow Loop, but this console mints participant tokens for whoever opens the
    link, so close it when the demo ends:

        Get-Process cloudflared | Stop-Process
  */
  allowedDevOrigins: ["*.trycloudflare.com", "trycloudflare.com"],

  /*
    ── ONE ORIGIN SERVES BOTH LOOPS, AND THAT IS THE WHOLE POINT ────────────
    Reported live: the console loaded fine over a tunnel and then sat on

        TRANSCRIPT FORWARDING PAUSED: SLOW LOOP RETURNED HTTP 404

    with an empty transcript, an empty Ledger and no graph.

    `delta-socket.ts` falls back to the page's OWN origin when
    NEXT_PUBLIC_SLOW_LOOP_WS is unset (correct for a guest — their 127.0.0.1
    is their own laptop, not the host's). Over a tunnel that origin is this
    Next.js server on :3000, which has no `/observer/transcript`, so every
    forwarded turn got Next's 404 page. Measured directly:

        next.js :3000 /observer/transcript -> 404
        python  :8000 /observer/transcript -> 200

    The same wrong origin took the delta socket down with it, which is why
    the dashboard never populated either: one cause, three symptoms.

    `start.ps1` used to paper over this by opening a SECOND tunnel and writing
    NEXT_PUBLIC_SLOW_LOOP_WS — and when its health check failed it CLEARED
    that variable, dropping straight back into this hole. Proxying here makes
    the same-origin fallback true instead of merely assumed, so one tunnel is
    enough and there is no variable left to go stale.

    `delta-socket.ts:333` already documented this as the missing piece:
    "this requires the console tunnel to proxy /ws/deltas and the other Slow
    Loop paths to :8000 - start.ps1 -Share does not do that today."

    WebSockets included: Next's rewrites proxy the upgrade for `/ws/deltas`.
  */
  async rewrites() {
    return SLOW_LOOP_PATHS.map((source) => ({
      source,
      destination: `${SLOW_LOOP_ORIGIN}${source}`,
    }));
  },
};

export default nextConfig;
