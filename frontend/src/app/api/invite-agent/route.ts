import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import { agoraAuthHeader, mintTokens } from "@/lib/server/agora-tokens";
import { buildAgentPayload } from "@/lib/server/agent-config";
import {
  AGENT_UID,
  putEntry,
  RosterWriteError,
} from "@/lib/server/roster";

/**
 * POST /api/invite-agent — v6 W1, "Fast Loop startup".
 *
 * Launches the Agora Cloud Agent bound to the OpenAI Realtime API, then writes
 * Echo into the Roster as `kind: "agent"`.
 *
 * ── WHY THE ROSTER WRITE MATTERS HERE ───────────────────────────────────────
 * The Observer builds its self-audio exclusion set from `kind: "agent"`
 * (v6 §4.3). If Echo joins the channel without a roster entry, the Observer
 * transcribes Echo's own speech, attributes it to an unknown UID, and feeds it
 * back into the Ledger as if a human had said it. Echo then contradicts itself
 * and the contradiction engine fires on its own output.
 *
 * That is G2, and it is a feedback loop, not a cosmetic bug — so the write
 * happens even if the agent invite partially fails, and a failure to write is
 * loud.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * DEGRADATION (v6 §13): if the invite fails, the Slow Loop is unaffected. The
 * dashboard still populates and only voice is missing — a degraded but
 * demonstrable system. So this route reports failure without tearing anything
 * down, and the caller is expected to keep the bridge open.
 */

interface InviteRequest {
  channel?: string;
  /** Public URL Agora calls for tool invocations (v6 §5.2). Optional in S1. */
  toolWebhookUrl?: string;
}

export async function POST(request: Request) {
  let body: InviteRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const channel = body.channel?.trim();
  if (!channel) {
    return NextResponse.json({ error: "channel is required" }, { status: 400 });
  }

  try {
    // Echo publishes (it speaks) and subscribes (it listens).
    const agentTokens = mintTokens(channel, AGENT_UID, { publisher: true });

    const vendor = serverEnv.ttsVendor;

    const payload = buildAgentPayload({
      channel,
      agentUid: AGENT_UID,
      agentRtcToken: agentTokens.rtcToken,
      groqApiKey: serverEnv.groqApiKey,
      tts: {
        vendor,
        apiKey: serverEnv.ttsApiKey,
        ...(vendor === "elevenlabs"
          ? { voiceId: serverEnv.elevenLabsVoiceId }
          : {
              speaker: serverEnv.sarvamSpeaker,
              language: serverEnv.sarvamLanguage,
            }),
      },
      toolWebhookUrl: body.toolWebhookUrl,
    });

    const url = `${serverEnv.agoraApiBase}/api/conversational-ai-agent/v2/projects/${serverEnv.agoraAppId}/join`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: agoraAuthHeader(),
      },
      body: JSON.stringify(payload),
      // A hung invite must not hold the bridge open indefinitely; the UI needs
      // to fall through to the degraded path promptly.
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok) {
      console.error("[/api/invite-agent] Agora rejected the invite", {
        status: response.status,
        body: parsed,
      });
      return NextResponse.json(
        {
          error: "Agent invite failed",
          status: response.status,
          detail: parsed,
          degraded: true,
          hint: "Slow Loop is unaffected — the dashboard still works without voice.",
        },
        { status: 502 },
      );
    }

    const agentId =
      (parsed as { agent_id?: string; agentId?: string }).agent_id ??
      (parsed as { agentId?: string }).agentId ??
      null;

    // Register Echo so the Observer can exclude its audio.
    await putEntry({
      channel,
      uid: AGENT_UID,
      role: "Echo",
      kind: "agent",
      // Echo can never approve a critical action. It is the thing being gated.
      authorized: false,
      issuedAt: Date.now(),
      expiresAt: agentTokens.expiresAt,
    });

    return NextResponse.json({
      agentId,
      agentUid: AGENT_UID,
      channel,
      expiresAt: agentTokens.expiresAt,
    });
  } catch (error) {
    if (error instanceof MissingEnvError) {
      return NextResponse.json(
        { error: error.message, hint: "See frontend/.env.local.example" },
        { status: 503 },
      );
    }

    if (error instanceof RosterWriteError) {
      return NextResponse.json(
        {
          error: `Agent joined but the roster write failed: ${error.message}`,
          hint: "The Observer cannot exclude Echo's audio — stop the agent (G2).",
        },
        { status: 502 },
      );
    }

    if (error instanceof Error && error.name === "TimeoutError") {
      return NextResponse.json(
        { error: "Agora did not respond within 15s", degraded: true },
        { status: 504 },
      );
    }

    console.error("[/api/invite-agent] unexpected failure", error);
    return NextResponse.json({ error: "Agent invite failed" }, { status: 500 });
  }
}
