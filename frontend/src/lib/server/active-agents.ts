/**
 * Which Agora agent is live on which channel — Zone 2 only.
 *
 * NOT marked `server-only`, deliberately and by the same reasoning as
 * `roster.ts`: that marker is required of modules that read a SECRET, and this
 * one holds agent ids and a loopback URL. The zone boundary is held by the
 * path-based import ban in `phase1-evaluation.test.ts` — a client file
 * importing from `@/lib/server/` fails the build regardless — so the marker
 * would add nothing here except making the module unimportable from tests.
 *
 * This module is imported by the test suite under plain `node --test`, so it
 * must stay free of `@/` aliases and extensionless relative imports. Agora-
 * touching logic — including the liveness probe that guards `invite-agent`'s
 * reuse branch — lives in the route instead, on the far side of the bundler.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two problems, both found on Aug 31 while checking whether Echo had ever
 * actually spoken. It had not.
 *
 * 1. NOBODY WAS INVITING ECHO. The console minted tokens and joined RTC, and
 *    that was all. `/api/invite-agent` existed, was tested, and was called by
 *    nothing. So the product — an AI that joins a voice bridge and talks — was
 *    never joining the bridge.
 *
 * 2. NOBODY WAS STOPPING IT EITHER. `closeBridge` left the RTC channel, which
 *    does nothing to the Cloud Agent: it keeps running, and keeps billing,
 *    until Agora times it out. Rehearsing the demo ten times would leave ten
 *    agents in the channel talking over each other.
 *
 * ── WHY THE MAP IS NEEDED AT ALL ───────────────────────────────────────────
 * §18 requires TWO humans on two machines. Both consoles join the same
 * channel, so both would invite an agent, and the room would get two Echoes
 * answering every question in slightly different words. Invite has to be
 * idempotent per channel, and idempotency needs somewhere to remember.
 *
 * In-memory, like the Roster it sits beside, and with the same caveat: this
 * does not survive a serverless deployment or a dev-server restart. For a
 * single dev server driving a demo it is exactly right, and the honest fix is
 * the same as the Roster's — move it to the Python side.
 */

interface ActiveAgent {
  agentId: string;
  channel: string;
  startedAt: number;
  expiresAt: number;
  /**
   * The ONE participant this agent subscribes to.
   *
   * Agora's Conversational AI Engine listens to exactly one uid, fixed at
   * creation. Reusing an agent for a console that has since been allocated a
   * different uid gives you an agent that is alive, healthy and deaf to the
   * person actually in the room — the failure that made this field necessary.
   */
  userUid: number;
}

const agents = new Map<string, ActiveAgent>();

/** The live agent on this channel, if one is still within its token window. */
export function getActiveAgent(channel: string): ActiveAgent | null {
  const found = agents.get(channel);
  if (!found) return null;

  // An agent whose token has expired is gone whether or not we noticed.
  // Returning it would make invite idempotent against a corpse, and the room
  // would sit waiting for a voice that cannot come back.
  if (found.expiresAt <= Date.now()) {
    agents.delete(channel);
    return null;
  }
  return found;
}

export function rememberAgent(entry: ActiveAgent): void {
  agents.set(entry.channel, entry);
}

export function forgetAgent(channel: string): ActiveAgent | null {
  const found = agents.get(channel) ?? null;
  agents.delete(channel);
  return found;
}

/** Where Zone 3 lives, as HTTP. */
function slowLoopBase(): string {
  /*
    ── THIS IS SERVER-SIDE, SO IT MUST NOT USE THE PUBLIC URL ────────────────
    `NEXT_PUBLIC_SLOW_LOOP_WS` exists for the BROWSER: once the console is
    shared over a tunnel, a guest's `127.0.0.1` is their own laptop. But this
    module runs inside the Next.js server, on the same machine as the Slow
    Loop, and routing it through the tunnel breaks it in a way that is easy to
    misread.

    The tunnel gate in `main.py` refuses any request arriving with a non-local
    Host unless it carries AGENT_TOOL_SECRET. These calls do not carry it — it
    is meant for Agora's tool invocations — so `/agent/start` came back 401 and
    the invite failed with "the Slow Loop never created the agent", while the
    exact same call to 127.0.0.1:8000 succeeded immediately.

    So: an explicit server-side override if one is ever needed, otherwise
    always loopback. Never the public URL.
  */
  const serverSide = process.env.SLOW_LOOP_INTERNAL_URL?.trim();
  if (serverSide) return serverSide.replace(/\/+$/, "");
  return "http://127.0.0.1:8000";
}

/**
 * Tell the Slow Loop which agent to speak through.
 *
 * The Bridge Controller cannot speak without an agent id, and ONLY Zone 2
 * knows it — Zone 2 holds the Agora credentials that created the agent, and
 * §10.1 says those never cross into Zone 3. So this hop is structural, not
 * incidental: it is the one piece of information that has to travel.
 *
 * Deliberately never throws. A Slow Loop that is down must not fail the
 * invite — §17's standing rule is that the dashboard never depends on the
 * Fast Loop, and the reverse holds too. Echo joins the channel and can be
 * heard; only Echo's *analysis-driven* speech is lost, which the degradation
 * banner already covers.
 */
export async function registerWithSlowLoop(
  agentId: string,
  channel: string,
  /**
   * Whether the agent was created with a reachable Ledger. The Slow Loop says
   * this out loud when Echo joins, so the room learns what Echo can and cannot
   * do at the start rather than when someone asks and gets a refusal.
   */
  toolsEnabled = false,
  /**
   * Whether Echo should announce itself. True only when this call CREATED the
   * agent — the Slow Loop cannot work that out for itself, because it holds
   * the agent id in memory and so treats every agent as new after a restart.
   */
  greet = true,
): Promise<boolean> {
  /*
    ── RETRIED, BECAUSE ONE MISSED CALL USED TO MUTE ECHO FOR THE SESSION ────
    Registration happens once, at invite. If it failed there was no second
    chance: the console showed "ECHO CANNOT SPEAK" and the only cure was to
    leave and rejoin.

    And the window it can fail in is one people walk straight into. Starting
    or restarting the tunnel restarts BOTH services, so anyone who presses J
    in those two seconds gets a connection refused and a permanently silent
    Echo. Reported live, exactly that way.

    Three attempts over ~3s. Long enough to ride out a service coming back,
    short enough that nobody is left watching a spinner.
  */
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${slowLoopBase()}/agent/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, channel, toolsEnabled, greet }),
        // Registration also composes and speaks the join line, which is a
        // round trip to Agora's TTS — 4s was tight enough to time out on a
        // healthy path and report Echo as mute when it was merely talking.
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return true;
      console.warn(`[agents] Slow Loop registration returned ${response.status} (attempt ${attempt}/3)`);
    } catch (error) {
      console.warn(`[agents] Slow Loop registration failed (attempt ${attempt}/3)`, error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }

  console.warn("[agents] Slow Loop never accepted the agent id — Echo will be mute");
  return false;
}

/**
 * The other half of registration, and it is not optional bookkeeping.
 *
 * Without it a stopped agent stayed registered, so the Bridge Controller kept
 * a dead id: `/speak` was issued against an agent that had left, failed, and
 * raised the degradation banner for a reason invisible from the room. The
 * pre-flight reported it as a leftover agent that no reset could clear,
 * because only restarting the backend cleared it.
 */
export async function unregisterWithSlowLoop(channel: string): Promise<void> {
  try {
    await fetch(`${slowLoopBase()}/agent/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Best-effort on the way out; a stale id is corrected by the next invite.
  }
}

/**
 * Ask the Slow Loop to CREATE the agent through the Agora SDK.
 *
 * ── WHY THE PAYLOAD NO LONGER LIVES IN THIS PROCESS ─────────────────────────
 * It used to be assembled by hand in `agent-config.ts`. Agora returns 200 for
 * a payload it only partly understands, so every misplaced field failed
 * silently — and the one that survived longest cost the whole product: the
 * recogniser never ran, and `content` came back EMPTY for turns carrying
 * seconds of real speech.
 *
 * The Python SDK derives the vendor presets rather than asserting them, and
 * refuses to construct an invalid recogniser at all. So Zone 3 creates the
 * agent and Zone 2 sends only what Zone 2 owns: the prompt and the tools.
 *
 * §10.1 is not violated. The Agora CREDENTIALS still never leave this process
 * for the REST paths, and the app id/certificate the SDK needs are read by the
 * backend from its own environment — not passed across the wire.
 */
export interface StartAgentResult {
  ok: boolean;
  agentId?: string;
  error?: string;
  degraded?: boolean;
}

export async function startAgentViaSlowLoop(payload: {
  channel: string;
  agentUid: number;
  userUid: number;
  systemPrompt: string;
  tts: Record<string, unknown>;
  /** Spoken by the Engine on join — the quickstart's `greeting_message`. */
  greeting?: string;
  llmMode: string;
  groqApiKey?: string;
  groqModel?: string;
  tools?: unknown[];
  greet?: boolean;
}): Promise<StartAgentResult> {
  /*
    Retried for the same reason registration is: starting or restarting the
    tunnel restarts BOTH services, and anyone who presses J in that window
    would otherwise get a permanently silent Echo.
  */
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${slowLoopBase()}/agent/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // Agora can take a while to bring a session up; longer than the old
        // 15s REST timeout because the SDK also waits for RUNNING.
        signal: AbortSignal.timeout(45000),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok && body.ok) {
        return { ok: true, agentId: String(body.agentId ?? "") };
      }
      // A 502 here is Agora rejecting the agent — a real answer, not a
      // transport failure. Retrying it just delays the degraded banner.
      if (response.status === 502) {
        return {
          ok: false,
          error: String(body.error ?? "Agora rejected the agent"),
          degraded: true,
        };
      }
      console.warn(`[agents] /agent/start returned ${response.status} (attempt ${attempt}/3)`);
    } catch (error) {
      console.warn(`[agents] /agent/start failed (attempt ${attempt}/3)`, error);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return { ok: false, error: "the Slow Loop never created the agent", degraded: true };
}

export async function stopAgentViaSlowLoop(agentId: string): Promise<void> {
  try {
    await fetch(`${slowLoopBase()}/agent/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Best effort; Agora's idle timeout is the backstop.
  }
}
