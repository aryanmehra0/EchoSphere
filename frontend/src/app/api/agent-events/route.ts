import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import {
  agoraAuthHeader,
  mintTokens,
  TOKEN_TTL_SECONDS,
} from "@/lib/server/agora-tokens";
import { AGENT_UID, touchExpiry } from "@/lib/server/roster";

/**
 * POST /api/agent-events — the Agora webhook. v6 W7.
 *
 * Event 104 means "this agent's token is about to expire". Tokens default to
 * 3600s, and a Sev-1 bridge outlasts that routinely. Without this handler Echo
 * silently drops off the channel roughly an hour in — which is exactly when a
 * real incident is at its most active, and exactly when nobody has attention
 * to spare for debugging why the AI went quiet.
 *
 * v5 covered the agent only. v6 W7 is explicit that the OBSERVER renews too,
 * on its own T-minus-300s timer: it holds a token with the same TTL and would
 * take the entire dashboard down with it. That half is implemented in the
 * Python worker (S2); this route serves its renewal via /api/token.
 */

/** Agora Conversational AI event codes we act on. */
const EVENT_AGENT_TOKEN_EXPIRING = 104;

interface AgentEvent {
  event_type?: number;
  eventType?: number;
  agent_id?: string;
  agentId?: string;
  channel_name?: string;
  channel?: string;
}

/**
 * Constant-time comparison for the webhook signature.
 *
 * A plain `===` on a secret leaks its prefix through timing. This endpoint is
 * public by necessity — Agora has to reach it — so it is the one piece of S1
 * an attacker can address directly.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: Request) {
  const raw = await request.text();

  // Verify before parsing. An unauthenticated caller should never reach the
  // JSON parser, let alone the token minter.
  const expected = serverEnv.agentEventsSecret;
  if (expected) {
    const provided =
      request.headers.get("x-agora-signature") ??
      request.headers.get("authorization") ??
      "";
    if (!safeEqual(provided, expected)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    // Loud, because an unauthenticated public endpoint that mints credentials
    // is a real exposure and it is easy to forget in a sprint.
    console.warn(
      "[/api/agent-events] AGORA_WEBHOOK_SECRET is unset — endpoint is UNAUTHENTICATED.",
    );
  }

  let event: AgentEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const eventType = event.event_type ?? event.eventType;
  const agentId = event.agent_id ?? event.agentId;
  const channel = event.channel_name ?? event.channel;

  if (eventType !== EVENT_AGENT_TOKEN_EXPIRING) {
    // Acknowledge everything else. Returning non-2xx for events we do not
    // handle invites Agora to retry them forever.
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  if (!agentId || !channel) {
    return NextResponse.json(
      { error: "event 104 requires agent_id and channel_name" },
      { status: 400 },
    );
  }

  try {
    const fresh = mintTokens(channel, AGENT_UID, { publisher: true });

    const url = `${serverEnv.agoraApiBase}/api/conversational-ai-agent/v2/projects/${serverEnv.agoraAppId}/agents/${agentId}/update`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: agoraAuthHeader(),
      },
      body: JSON.stringify({ token: fresh.rtcToken }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[/api/agent-events] token renewal rejected", {
        status: response.status,
        detail,
      });
      return NextResponse.json(
        { error: "Renewal rejected", status: response.status },
        { status: 502 },
      );
    }

    await touchExpiry(channel, AGENT_UID, fresh.expiresAt);

    return NextResponse.json({
      ok: true,
      renewed: AGENT_UID,
      expiresAt: fresh.expiresAt,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    if (error instanceof MissingEnvError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[/api/agent-events] renewal failed", error);
    return NextResponse.json({ error: "Renewal failed" }, { status: 500 });
  }
}

/** Some webhook configurators probe with GET before accepting a URL. */
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "agent-events" });
}
