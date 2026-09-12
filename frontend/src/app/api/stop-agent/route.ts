import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import { agoraAuthHeader } from "@/lib/server/agora-tokens";
import { forgetAgent, unregisterWithSlowLoop } from "@/lib/server/active-agents";
import { releaseEntry } from "@/lib/server/roster";

/**
 * POST /api/stop-agent — end Echo's session on a channel.
 *
 * ── WHY THIS HAD TO EXIST ──────────────────────────────────────────────────
 * Leaving the RTC channel does NOTHING to the Cloud Agent. It is a separate
 * server-side process that Agora keeps running — and billing — until its own
 * timeout. Until Aug 31 there was no way to stop one from inside the app, so
 * every rehearsal left another Echo in the channel. Ten rehearsals, ten agents,
 * all subscribed to the same audio, all trying to answer.
 *
 * That is not just a cost problem. It is the single most likely way to make a
 * live demo look broken, and it gets worse the more you practise.
 */
export async function POST(request: Request) {
  let channel: string | undefined;
  let uid: number | undefined;
  try {
    const body = (await request.json()) as { channel?: string; uid?: number };
    channel = body.channel?.trim();
    uid = typeof body.uid === "number" && body.uid > 0 ? body.uid : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!channel) {
    return NextResponse.json({ error: "channel is required" }, { status: 400 });
  }

  /*
    ── ONE PERSON LEAVING MUST NOT SILENCE THE ROOM ──────────────────────────
    This route is channel-wide: it stops the Cloud Agent for everyone. That
    was correct while a bridge was one person, and wrong the moment three
    joined — the first to press Q killed Echo for the two still talking, with
    nothing on their screens to explain it.

    So a leaver now releases its own roster row and the agent is stopped only
    when nobody is left. `uid` is optional: a caller that does not send one
    (the demo scripts, `npm run demo stop`) keeps the old unconditional
    behaviour, which is what those callers actually want.

    Deliberately NOT reference-counted in a separate structure — the roster
    already knows who is on the channel, and a second source of truth about
    occupancy would be one more thing to drift.
  */
  if (uid !== undefined) {
    const { humansRemaining } = await releaseEntry(channel, uid);
    if (humansRemaining > 0) {
      return NextResponse.json({
        stopped: false,
        reason: `${humansRemaining} participant(s) still on the bridge`,
        humansRemaining,
      });
    }
  }

  // Release the agent entry from the roster so it does not linger as a ghost.
  await releaseEntry(channel, 9000);

  // Forget FIRST, so a failed leave cannot strand the channel with a
  // permanently un-reinvitable agent. Worst case Agora times the orphan out;
  // the alternative is a channel nobody can put an agent back into.
  const agent = forgetAgent(channel);

  // Always tell the Slow Loop, even when Zone 2 had nothing to forget: the
  // registration outlives this process, so a dev-server restart would
  // otherwise strand a dead agent id in the Bridge Controller forever.
  await unregisterWithSlowLoop(channel);

  if (!agent) {
    return NextResponse.json({ stopped: false, reason: "no active agent" });
  }

  try {
    const url =
      `${serverEnv.agoraApiBase}/api/conversational-ai-agent/v2/projects/` +
      `${serverEnv.agoraAppId}/agents/${agent.agentId}/leave`;

    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: agoraAuthHeader() },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("[/api/stop-agent] Agora refused the leave", {
        status: response.status,
        detail,
      });
      return NextResponse.json(
        {
          stopped: false,
          agentId: agent.agentId,
          status: response.status,
          hint: "The agent may linger until Agora times it out.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ stopped: true, agentId: agent.agentId, channel });
  } catch (error) {
    if (error instanceof MissingEnvError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[/api/stop-agent] unexpected failure", error);
    return NextResponse.json(
      { stopped: false, agentId: agent.agentId, error: "leave request failed" },
      { status: 500 },
    );
  }
}
