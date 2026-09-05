import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import { agoraAuthHeader, mintTokens } from "@/lib/server/agora-tokens";
import { buildAgentPayload } from "@/lib/server/agent-config";
import { selectFastLoopModel } from "@/lib/server/groq-budget";
import {
  AGENT_UID,
  putEntry,
  RosterWriteError,
} from "@/lib/server/roster";
import {
  getActiveAgent,
  registerWithSlowLoop,
  rememberAgent,
} from "@/lib/server/active-agents";

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
  /**
   * The human the agent subscribes to. Agora supports exactly ONE, so this is
   * not optional — a missing value used to become `"*"`, which matches no
   * participant and left the agent deaf.
   */
  userUid?: number;
  /** Public URL Agora calls for tool invocations (v6 §5.2). Optional in S1. */
  /** Overrides AGENT_TOOL_BASE_URL for a one-off run. */
  toolBaseUrl?: string;
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

  const userUid = Number(body.userUid);
  if (!Number.isInteger(userUid) || userUid <= 0) {
    // Rejected rather than defaulted. The previous default was a wildcard the
    // API does not support, and it failed by making the agent silently deaf —
    // the single most expensive bug in this project.
    return NextResponse.json(
      { error: "userUid is required — the agent subscribes to exactly one participant" },
      { status: 400 },
    );
  }

  /*
    IDEMPOTENT PER CHANNEL, and §18 is why.

    Two humans on two machines is a hard requirement, and both their consoles
    join the same channel. Without this check both would invite an agent and
    the room would get two Echoes answering every question in slightly
    different words — which looks exactly like the product being broken.
  */
  const existing = getActiveAgent(channel);
  if (existing) {
    /*
      ── RE-REGISTER, EVEN THOUGH THE AGENT ALREADY EXISTS ───────────────────
      This branch used to return here without telling the Slow Loop anything,
      and that was two bugs wearing one coat.

      The silent one: this map lives in the Next.js process and the agent id
      lives in the Python one. Restart Python alone and it has forgotten the
      id, while this map still says "already handled" — so every rejoin short-
      circuits here, the Slow Loop never learns the id, and Echo is mute for
      the rest of the session with no way back except a different channel.

      The loud one: the response carried no `registeredWithSlowLoop`, so the
      console read `undefined`, took it for false, and raised "ECHO CANNOT
      SPEAK — the Slow Loop never received the agent id" over an Echo that was
      working perfectly. Reported live.

      Registering again is cheap and idempotent — the Slow Loop skips the
      greeting when the id is unchanged, so nobody hears Echo introduce itself
      twice.
    */
    const registered = await registerWithSlowLoop(
      existing.agentId,
      channel,
      Boolean(body.toolBaseUrl ?? serverEnv.agentToolBaseUrl),
      // Reused, not created: Echo is already in the room and has already said
      // so. Greeting again on every reload is the filler §14.1 forbids.
      false,
    );
    return NextResponse.json({
      agentId: existing.agentId,
      agentUid: AGENT_UID,
      channel,
      expiresAt: existing.expiresAt,
      reused: true,
      registeredWithSlowLoop: registered,
      toolsEnabled: Boolean(body.toolBaseUrl ?? serverEnv.agentToolBaseUrl),
    });
  }

  try {
    // Echo publishes (it speaks) and subscribes (it listens).
    const agentTokens = mintTokens(channel, AGENT_UID, { publisher: true });

    const vendor = serverEnv.ttsVendor;

    /*
      Ask Groq which key and model can actually answer BEFORE handing one to
      Agora. Costs one round trip on the happy path; the alternative is an
      agent that joins, greets, and then says "One moment." to everything
      because the key it was given has no daily budget left.
    */
    const fastLoop = await selectFastLoopModel();
    if (!fastLoop.verified) {
      console.warn("[agents] no Groq key answered — Echo will be mute:", fastLoop.detail);
    }

    const payload = buildAgentPayload({
      channel,
      agentUid: AGENT_UID,
      userUid,
      agentRtcToken: agentTokens.rtcToken,
      groqApiKey: fastLoop.apiKey,
      groqModel: fastLoop.model,
      llmMode: serverEnv.llmMode,
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
      // Agora calls tools from ITS servers, so this must be publicly
      // reachable. Null disables tools rather than attaching broken ones.
      toolBaseUrl: body.toolBaseUrl ?? serverEnv.agentToolBaseUrl,
      toolSecret: serverEnv.agentToolSecret,
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

    /*
      Hand the agent id to the Slow Loop.

      This is the hop that was missing entirely until Aug 31, and its absence
      was invisible: every other part of the chain worked, the dashboard filled
      with claims, contradictions were detected and recorded — and Echo never
      said a word, because the Bridge Controller had no agent to speak through.
      Nothing failed. It was just silent.

      Only Zone 2 can do this. It holds the Agora credentials that created the
      agent, and §10.1 forbids those crossing into Zone 3, so the id itself is
      the one thing that has to travel.
    */
    if (agentId) {
      rememberAgent({
        agentId,
        channel,
        startedAt: Date.now(),
        expiresAt: agentTokens.expiresAt,
      });
    }
    const toolsEnabled = Boolean(body.toolBaseUrl ?? serverEnv.agentToolBaseUrl);
    const registered = agentId
      ? await registerWithSlowLoop(agentId, channel, toolsEnabled)
      : false;

    return NextResponse.json({
      agentId,
      agentUid: AGENT_UID,
      channel,
      expiresAt: agentTokens.expiresAt,
      // Surfaced rather than swallowed: an agent that joined but is not
      // registered can be HEARD but will never speak about the incident, and
      // that distinction is impossible to diagnose from the room.
      registeredWithSlowLoop: registered,
      // Whether Echo can actually READ the Ledger. Without tools it can still
      // hear and speak, but every factual answer would come from the model's
      // own memory — so the console needs to know, and say so.
      toolsEnabled,
      /*
        Which key and model Agora was actually given, and whether either could
        answer. NEVER the key itself — the index is what makes a report
        actionable without putting a credential in an HTTP response.

        `voiceVerified: false` is the state that used to be invisible: Echo
        joins, greets, and then answers every question with Agora's
        `failure_message` because the key it was handed has no daily budget
        left. The Slow Loop rotates past that; the Fast Loop cannot.
      */
      fastLoop: {
        mode: serverEnv.llmMode,
        model: serverEnv.llmMode === "managed" ? "gpt-4o-mini (Agora-managed)" : fastLoop.model,
        keyIndex: fastLoop.keyIndex,
        voiceVerified: fastLoop.verified,
        ...(fastLoop.detail ? { detail: fastLoop.detail } : {}),
      },
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
