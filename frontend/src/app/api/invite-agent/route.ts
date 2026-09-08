import { NextResponse } from "next/server";

import { MissingEnvError, serverEnv } from "@/lib/server/env";
import { agoraAuthHeader, mintTokens } from "@/lib/server/agora-tokens";
import {
  buildSystemPrompt,
  buildToolsBlock,
  DEFAULT_GREETING,
} from "@/lib/server/agent-config";
import { selectFastLoopModel } from "@/lib/server/groq-budget";
import {
  AGENT_UID,
  getRoster,
  putEntry,
  RosterWriteError,
} from "@/lib/server/roster";
import {
  getActiveAgent,
  registerWithSlowLoop,
  rememberAgent,
  forgetAgent,
  startAgentViaSlowLoop,
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

/*
  TRUST NOTHING THE LOCAL MAP SAYS, ASK THE VENDOR.

  The map reuses an entry so two consoles never spawn two Echoes. But reuse
  against a dead entry is how Echo went mute for a whole session: Agora ended
  the session (idle timeout, vendor failure) while the map — and the Slow
  Loop — kept the id, so every rejoin "reused" a corpse that could neither
  listen nor speak, and no local signal ever disagreed. The token-expiry
  guard cannot catch it, so liveness is asked of Agora directly.

  FAIL-CLOSED BY DESIGN: a probe that cannot answer ("network error", a 5xx,
  a 404 that does not say the session is over) keeps the entry. The opposite
  trade — evicting on ambiguity — could leave two consoles each spawning an
  agent in one room (§18), the loud failure this idempotent map exists to
  prevent. A mute Echo is recoverable; two Echoes argue.
*/
type AgentLiveness = "living" | "ended" | "unknown";

async function agentLiveness(agentId: string): Promise<AgentLiveness> {
  try {
    const base =
      `${serverEnv.agoraApiBase}/api/conversational-ai-agent/v2/projects/` +
      `${serverEnv.agoraAppId}/agents/${agentId}`;
    const response = await fetch(base, {
      headers: { Authorization: agoraAuthHeader() },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      /*
        ── A 200 DOES NOT MEAN THE AGENT IS ALIVE ──────────────────────────
        This used to `return "living"` on any 200, and that is how the console
        spent a session talking to a corpse. Agora answers the read surface
        for an agent it has already ENDED, with HTTP 200 and a body that says
        so plainly:

            {"agent_id": "...", "status": "STOPPED", "stop_ts": 1788678053}

        So the entry was reused, `/agent/start` was never called, a dead agent
        id was handed to the Bridge — and the room got a greeting from the
        PREVIOUS session's agent while nothing anyone said was transcribed.
        Identical from the outside to the deaf-ASR bug this project just spent
        days removing, which is exactly why it has to be checked here.

        The status field is the authority; the HTTP code only says the read
        succeeded.
      */
      const body = (await response.json().catch(() => null)) as
        | { status?: string }
        | null;
      const state = body?.status?.toUpperCase();
      if (state === "RUNNING" || state === "STARTING" || state === "CREATING") {
        return "living";
      }
      if (state) {
        console.warn(`[agents] ${agentId} reports status ${state} — not reusable`);
        return "ended";
      }
      // A 200 with no status we recognise: fail closed toward reuse, per the
      // note above `agentLiveness`.
      return "unknown";
    }

    const text = await response.text();
    // A plain 404 is not enough: a still-CREATING session can 404 against the
    // read surface too, and evicting one would spawn a duplicate. Recreate
    // only on Agora's explicit "this session is over" answer — the exact body
    // stop-agent already received live (reason: TaskNotFound).
    if (
      response.status === 404 &&
      /TaskNotFound|has already ended|failed to start|not found/i.test(text)
    ) {
      return "ended";
    }

    console.warn(`[agents] liveness probe for ${agentId} -> HTTP ${response.status}`, text.slice(0, 300));
    return "unknown";
  } catch (error) {
    console.warn(`[agents] liveness probe for ${agentId} failed`, error);
    return "unknown";
  }
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
  let reuseExisting = false;

  /*
    ── CARRY THE OUTGOING AGENT'S SUBSCRIBERS INTO ITS REPLACEMENT ──────────
    Agora fixes `remote_rtc_uids` at creation, so adding a third person means
    building a NEW agent. `forgetAgent` then erased the old one's subscriber
    list and the rebuild was gathered from the roster alone.

    That is why Echo ended up listening only to whoever joined LAST: each join
    replaced the agent, and if the roster lookup missed the earlier joiners —
    a reload that reused a uid, a row past its token expiry — the replacement
    subscribed to the newcomer and nobody else. Person 3 could talk to it;
    persons 1 and 2 had been silently dropped by the very join that was
    supposed to add someone.

    So the previous agent's subscribers are remembered here and merged into
    the new one. The roster is the primary source; this is the floor beneath
    it, and it means each join can only ever ADD ears, never remove them.
  */
  const inheritedUids = existing?.subscribedUids ?? [];

  if (existing && !existing.subscribedUids.includes(userUid)) {
    /*
      ── THE AGENT LISTENS TO ONE UID, AND THIS CONSOLE IS NOT IT ────────────
      Agora fixes `remote_rtc_uids` when the agent is created and it cannot be
      changed afterwards. The Roster allocates uids sequentially and never
      releases them, so every reload of the console took the next one — 1001,
      1002, 1003 — while the agent stayed pinned to the first.

      Reusing it then produces the exact failure this cost days to find: an
      agent that is RUNNING, converses happily in its own history, and is deaf
      to the person actually in the room, because Agora runs no recogniser on
      a participant nobody subscribed to. Nothing errors. The transcript panel
      simply stays empty.

      Measured: a browser joined as 1002 against an agent subscribed to 1001
      and produced zero TRANSCRIPT_UPDATED events in 60 seconds.

      A tab now remembers its uid (see `requestBridgeCredentials`), so this
      should be rare — but when the uid does differ, the old agent is useless
      to this console and must be replaced rather than reused.
    */
    console.warn(
      `[/api/invite-agent] agent ${existing.agentId} subscribes to uid ` +
        `${existing.userUid}, but this console is uid ${userUid} — replacing it`,
    );
    forgetAgent(channel);
  }

  const stillExisting = getActiveAgent(channel);
  if (stillExisting) {
    /* Liveness guard — see the note above `agentLiveness`. */
    const liveness = await agentLiveness(stillExisting.agentId);
    if (liveness === "ended") {
      console.warn(
        `[/api/invite-agent] agent ${stillExisting.agentId} has ended at Agora — ` +
          "creating a replacement instead of reusing a corpse",
      );
      forgetAgent(channel);
    } else {
      // "living", or the probe could not answer and this branch fails closed
      // toward reuse. Evicting on ambiguity could have two consoles both
      // spawning an agent in one room (§18) — the loud failure this idempotent
      // map exists to prevent. A mute Echo is recoverable; two Echoes argue.
      reuseExisting = true;
    }
  }

  if (stillExisting && reuseExisting) {
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
      stillExisting.agentId,
      channel,
      Boolean(body.toolBaseUrl ?? serverEnv.agentToolBaseUrl),
      // Reused, not created: Echo is already in the room and has already said
      // so. Greeting again on every reload is the filler §14.1 forbids.
      false,
    );
    return NextResponse.json({
      agentId: stillExisting.agentId,
      agentUid: AGENT_UID,
      channel,
      expiresAt: stillExisting.expiresAt,
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

    /*
      ── THE AGENT IS NOW CREATED BY THE SLOW LOOP, THROUGH THE SDK ─────────
      This block used to hand-assemble the Agora create-agent payload and POST
      it to /join. Agora returns 200 for a payload it only partly understands,
      so every misplaced field failed silently — and the one that survived
      longest was fatal: the recogniser never ran. Agora's own history showed
      `{"role":"user","source":"asr","content":""}` for turns carrying 3.35s
      of real speech.

      The Python SDK derives the vendor presets instead of asserting them, and
      refuses to construct an invalid recogniser at all. Zone 2 still owns the
      two things Zone 2 should own — the prompt and the tool definitions — and
      sends them across; it no longer owns the wire format.
    */
    const toolsEnabledNow = Boolean(body.toolBaseUrl ?? serverEnv.agentToolBaseUrl);
    const toolsBlock = buildToolsBlock(
      body.toolBaseUrl ?? serverEnv.agentToolBaseUrl,
      serverEnv.agentToolSecret,
    ) as { tools?: unknown[] };

    /*
      ── EVERY HUMAN, NOT JUST THE INVITER ─────────────────────────────────
      The agent subscribes to the uids named here and is deaf to everyone
      else. Passing only `userUid` meant whoever pressed J first was the only
      person Echo could hear — the other roles spoke to an agent that never
      ran a recogniser on their audio.
    */
    /*
      LIVE entries only. The roster never evicts, so it accumulates a uid for
      every person who has ever held a token on this channel — including
      reloads that took a new uid and demos from an hour ago.

      Subscribing to those costs more than noise: `idle_timeout` stops the
      agent only once EVERY subscribed user has left the channel, so a list
      padded with uids that will never join again keeps a dead agent alive
      (and billing) for its full timeout.
    */
    const now = Date.now();
    const rosterUids = (await getRoster(channel))
      .filter((e) => e.kind === "human" && e.expiresAt > now)
      .map((e) => e.uid);

    // Roster first, then anyone the agent we are replacing could already hear.
    // Excludes this console (added separately as `userUid`) and the agent.
    const humans = [...new Set([...rosterUids, ...inheritedUids])].filter(
      (uid) => uid !== userUid && uid !== AGENT_UID && uid > 0,
    );

    const started = await startAgentViaSlowLoop({
      channel,
      agentUid: AGENT_UID,
      userUid,
      otherUids: humans,
      systemPrompt: buildSystemPrompt(toolsEnabledNow),
      /*
        ── ONE GREETING, AND IT IS THE ENGINE'S ────────────────────────────
        Echo used to join in total silence: the prompt forbade greeting and
        `greeting_message` was "". From inside the room a working agent and a
        dead one looked identical, which is the most expensive ambiguity in
        this project — hence an engine-level greeting that proves the LLM leg
        is alive.

        But BOTH halves were switched on. `greeting` makes the Engine speak,
        and `greet: true` makes the Slow Loop's Bridge speak
        `utterance.joined()` through /speak — two introductions per join, from
        two different components, which is the "saying the intro line again
        and again" that was reported.

        The Engine's is kept because it is the one that proves ASR -> LLM ->
        TTS is actually wired; a Bridge /speak only proves TTS. `greet` is
        therefore false below, always.

        Only a genuinely NEW session announces itself. Adding a third person
        replaces the agent, and an agent that reintroduces itself every time
        someone joins talks over a bridge already in progress — the filler
        §14.1 forbids, arriving through the join path.
      */
      greeting: inheritedUids.length > 0 ? "" : DEFAULT_GREETING,
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
      llmMode: serverEnv.llmMode,
      groqApiKey: fastLoop.apiKey,
      groqModel: fastLoop.model,
      ...(toolsBlock.tools ? { tools: toolsBlock.tools } : {}),
      // FALSE, always — see the `greeting` note above. The Engine already
      // announces the join; a Bridge /speak on top of it is a second
      // introduction in the same breath.
      greet: false,
    });

    if (!started.ok) {
      console.error("[/api/invite-agent] the Slow Loop could not create the agent", started.error);
      return NextResponse.json(
        {
          error: "Agent invite failed",
          detail: started.error,
          degraded: true,
          hint: "Slow Loop is unaffected — the dashboard still works without voice.",
        },
        { status: 502 },
      );
    }

    const agentId = started.agentId ?? null;

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
      NO SEPARATE REGISTER CALL ANY MORE.

      Creating the agent and telling the Slow Loop its id used to be two
      round trips, and losing the second one left Echo mute for the whole
      session with no cure but a new channel — the Bridge Controller had no
      agent to speak through, and nothing anywhere reported a failure.

      `/agent/start` now does both inside the process that owns the Bridge, so
      the id cannot go missing between them: if the agent exists, the Bridge
      already knows about it.
    */
    if (agentId) {
      rememberAgent({
        agentId,
        channel,
        startedAt: Date.now(),
        expiresAt: agentTokens.expiresAt,
        userUid,
        // Recorded so a console whose uid is NOT covered replaces this agent
        // instead of reusing one that cannot hear it.
        subscribedUids: [userUid, ...humans],
      });
    }
    const toolsEnabled = toolsEnabledNow;
    const registered = Boolean(agentId);

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
