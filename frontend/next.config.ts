import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
    ── LETTING COLLEAGUES REACH THIS CONSOLE THROUGH A TUNNEL ────────────────
    Next blocks cross-origin requests to dev-only assets and endpoints by
    default, so a bridge opened at `https://<something>.trycloudflare.com` and
    shared with the room loads a broken page: the HTML arrives, the dev assets
    are refused, and nothing says why.

    Named hosts rather than a blanket allow, and only the tunnel provider we
    actually use. This is a DEV-only option — it has no effect on a production
    build, so it widens nothing that ships.

    A tunnel is still a real hole while it is open. `AGENT_TOOL_SECRET` guards
    the Slow Loop, but this console mints participant tokens for whoever opens
    the link, so close the tunnel when the demo is over:

        Get-Process cloudflared | Stop-Process
  */
  allowedDevOrigins: ["*.trycloudflare.com", "trycloudflare.com"],
};

export default nextConfig;
