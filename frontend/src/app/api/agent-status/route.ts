import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import { agoraAuthHeader } from "@/lib/server/agora-tokens";
import { getActiveAgent } from "@/lib/server/active-agents";

/**
 * GET /api/agent-status?channel=inc-4417 — what does AGORA think the agent is doing?
 *
 * ── WHY ASK THE VENDOR RATHER THAN INFER ───────────────────────────────────
 * Every local signal says this should be working: the microphone transmits at
 * 0.8 peak, the agent is in the channel, it is subscribed to the real
 * participant uid, the recogniser has a vendor and a preset, turn detection is
 * on the current schema, and the transcript layer is listening on the RTC data
 * stream. Zero transcripts arrive, and nothing errors.
 *
 * At that point local instrumentation has nothing left to say. Agora holds the
 * other half of the picture — whether its pipeline started, which modules are
 * running, and what it thinks went wrong — and that is a question with an
 * endpoint rather than a guess.
 *
 * Read-only, and it returns Agora's response verbatim rather than a summary:
 * the whole reason this exists is that our interpretation of the state has
 * been wrong for days.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel")?.trim();
  const explicitId = url.searchParams.get("agentId")?.trim();

  const agentId = explicitId || (channel ? getActiveAgent(channel)?.agentId : null);
  if (!agentId) {
    return NextResponse.json(
      { error: "no agent — pass ?agentId= or ?channel= with a live agent" },
      { status: 404 },
    );
  }

  const base =
    `${serverEnv.agoraApiBase}/api/conversational-ai-agent/v2/projects/` +
    `${serverEnv.agoraAppId}/agents/${agentId}`;

  async function probe(path: string) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { Authorization: agoraAuthHeader() },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: text.slice(0, 2000) };
      }
    } catch (error) {
      return { status: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    // Both surfaces, because which one carries the module state is exactly the
    // kind of thing that has been guessed wrong here already.
    const [status, history] = await Promise.all([probe(""), probe("/history")]);
    return NextResponse.json({ agentId, status, history });
  } catch (error) {
    if (error instanceof MissingEnvError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
