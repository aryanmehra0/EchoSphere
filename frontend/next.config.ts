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
};

export default nextConfig;
