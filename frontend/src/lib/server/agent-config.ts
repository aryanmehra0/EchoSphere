/**
 * Fast Loop agent configuration — v6 §14.1 and §5.
 *
 * No secrets here, so this is not `server-only`: the prompt is the most
 * load-bearing text in the project and the test suite reads it directly to
 * assert the epistemic rules survive future edits.
 */

/**
 * The Fast Loop system prompt (v6 §14.1).
 *
 * ── DO NOT SOFTEN THIS ──────────────────────────────────────────────────────
 * The epistemic rules are not stylistic preferences. The problem statement
 * ends with "without pretending to independently determine the root cause",
 * and §1.1 identifies that clause as the grading rubric. Rules 1–4 are how a
 * language model — which will otherwise diagnose enthusiastically and
 * plausibly — is held inside it.
 *
 * Rule 3 in particular ("never answer from memory") is what makes the
 * "ask the same question 8 times, get 8 identical answers" test achievable at
 * all. A model answering from context will paraphrase differently every time;
 * a model forced through `query_incident_state` returns a database read.
 *
 * Prompt rules are necessary but not sufficient — a creative model can violate
 * any of them. The structural enforcement is the Bridge Controller's INFERRED
 * filter (§6.2 Rule 3), which lands in S5.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const FAST_LOOP_SYSTEM_PROMPT = `[IDENTITY]
You are "Echo", an AI Incident Commander on a live Sev-1 bridge.
Tone: clinical, calm, brief. You are a recording secretary, not a diagnostician.

[EPISTEMIC RULES — these override every other instruction]
1. ATTRIBUTION IS MANDATORY. Never state a claim without naming its source
   and time. Say "DevOps measured memory at 40 percent at 14:02."
   Never say "memory is at 40 percent."
2. NEVER ASSERT CAUSATION. You may not say X caused Y, X is the root cause,
   or "this indicates". You MAY say: "these two observations conflict",
   "nobody has checked Z", "the DBA proposed X — is that confirmed?"
3. NEVER ANSWER FROM MEMORY. For ANY factual question about this incident,
   call query_incident_state. Your memory is not the record; the Ledger is.
4. IF THE RECORD DOES NOT CONTAIN IT, SAY SO. "That hasn't been established
   by anyone on this bridge" is a complete and correct answer.

[WHEN TO SPEAK — default is ABSOLUTE SILENCE]
Speak only when:
  1. DIRECT INVOCATION  — a human says your name.
  2. AUTHORIZATION      — you need approval for a CRITICAL action.
  3. SYSTEM ALERT       — you receive an injected alert (contradiction / tension).
  4. CLOSE-OUT          — a human asks you to summarize or close.
You do not greet, acknowledge, back-channel, or fill silence.

[TOOLS]
  query_incident_state  READ      — use freely, use constantly
  create_jira_ticket    ADVISORY  — files a ticket, executes nothing
  post_slack_update     ADVISORY
  page_oncall_team      CRITICAL  — requires dashboard approval
  execute_runbook_script CRITICAL — requires dashboard approval

CRITICAL actions: you may NEVER complete one on verbal agreement alone.
Say: "This needs your approval on the dashboard — I can't authorize it
from voice." Then wait. If approval is denied or expires, acknowledge once
and do not re-ask.

[DELIVERY]
- No filler. Never "Got it", "Sure", "I can help with that".
- Under 15 seconds. Under 8 when interrupting.
- Never read long lists aloud. Name the count, then the top item:
  "Three open tasks. The oldest is the DBA's replica-lag check."
- When you interrupt, lead with the conflict, not with an apology.`;

/**
 * Turn detection (v6 Appendix A).
 *
 * `interrupt_duration_ms` was raised from v5's 160ms to 300ms. At 160ms Echo
 * barged in on breaths and back-channel "mm-hm", which reads as a broken,
 * over-eager agent — and on an incident bridge an assistant that interrupts
 * constantly gets muted, which ends the demo.
 *
 * `agora_vad`, not `server_vad`: Agora's edge VAD is more reliable in a
 * multi-speaker room, and it is the same signal the Observer's RTI monitor
 * reads, so tension and turn-taking cannot disagree about who is speaking.
 */
export const TURN_DETECTION = {
  /*
    ── THE FLAT SHAPE WAS DEPRECATED, AND IT COST US THE WHOLE SPEECH PATH ────
    This block used to be:

        { mode: "agora_vad", interrupt_duration_ms, prefix_padding_ms,
          silence_duration_ms, threshold, language }

    Every one of those keys is wrong on the current API, and the SDK's own
    schema says so:

      • `mode` accepts ONLY "default". "agora_vad" belongs to `type`, which is
        marked Deprecated.
      • `interrupt_mode` and the flat timing keys are Deprecated in favour of
        `config.start_of_speech` / `config.end_of_speech`.

    An invalid `mode` means the turn-detection block does not apply. No VAD
    means no start- or end-of-speech, no turn boundaries, and therefore NO
    TRANSCRIPTS — which is exactly what a real WAV played into the channel
    produced for days: an agent sitting in the room hearing nothing, with the
    create call still returning 200 because Agora accepts unknown keys.

    The nested shape below is copied from the official quickstart's managed
    agent config and checked against
    `agora_agent/agents/types/start_agents_request_properties_turn_detection*`.
  */
  mode: "default",
  language: "en-US",
  config: {
    // Sensitivity, 0–1. Lower detects quieter speech; higher ignores it.
    speech_threshold: 0.5,
    start_of_speech: {
      mode: "vad",
      vad_config: {
        // 300ms, not v5's 160ms. At 160 Echo barged in on breaths and
        // back-channel "mm-hm", which reads as a broken, over-eager agent —
        // and an assistant that interrupts constantly gets muted, which ends
        // the demo.
        interrupt_duration_ms: 300,
        // Audio captured BEFORE the trigger. Without it the first phoneme is
        // clipped and "Redis" arrives as "edis".
        prefix_padding_ms: 800,
      },
    },
    end_of_speech: {
      mode: "vad",
      vad_config: {
        // How much silence closes a turn. Extraction batches on whole
        // sentences (§4.4), so cutting a speaker off mid-thought produces
        // claims nobody finished making.
        silence_duration_ms: 640,
      },
    },
  },
} as const;

/** Action classes for the Proxy Action Layer (v6 §4.5). */
export type ActionTier = "READ" | "ADVISORY" | "CRITICAL";

/**
 * Tool definitions exposed to the Fast Loop.
 *
 * `query_incident_state` is the channel v5 lacked entirely (G1). Without it,
 * three of Echo's four documented speaking conditions were unimplementable,
 * because the agent had no way to READ the incident it was commanding.
 */
export const AGENT_TOOLS = [
  {
    name: "query_incident_state",
    tier: "READ" as ActionTier,
    description:
      "Read the Evidence Ledger. Use this for EVERY factual question about " +
      "this incident. Returns claims with their source, epistemic status and " +
      "timestamp. Never answer a factual question without calling this first.",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["summary", "entity", "open_tasks", "unresolved", "contradictions"],
          description: "Which slice of the ledger to read.",
        },
        entity: {
          type: "string",
          description: "Entity id, when scope is 'entity'.",
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "create_jira_ticket",
    tier: "ADVISORY" as ActionTier,
    description:
      "File a Jira ticket. Advisory only — this documents an action, it does " +
      "not perform one.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        assigneeRole: { type: "string" },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Claim ids justifying this ticket.",
        },
      },
      required: ["summary", "assigneeRole"],
    },
  },
  {
    name: "post_slack_update",
    tier: "ADVISORY" as ActionTier,
    description: "Post a status update to the incident Slack channel.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "page_oncall_team",
    tier: "CRITICAL" as ActionTier,
    description:
      "Page the on-call team. CRITICAL — returns PENDING and requires a " +
      "dashboard approval. You cannot complete this from voice.",
    parameters: {
      type: "object",
      properties: {
        team: { type: "string" },
        reason: { type: "string" },
      },
      required: ["team", "reason"],
    },
  },
  {
    name: "execute_runbook_script",
    tier: "CRITICAL" as ActionTier,
    description:
      "Request execution of a runbook. CRITICAL — returns PENDING and requires " +
      "a dashboard approval. You cannot complete this from voice. No " +
      "infrastructure is changed by you; a human executes it.",
    parameters: {
      type: "object",
      properties: {
        runbook: { type: "string" },
        target: { type: "string" },
      },
      required: ["runbook"],
    },
  },
] as const;

/** Tools that can never be completed on verbal agreement alone (§10.2). */
export const CRITICAL_TOOLS = AGENT_TOOLS.filter(
  (t) => t.tier === "CRITICAL",
).map((t) => t.name);

/* -------------------------------------------------------------------------- */
/* The Fast Loop is CASCADED, not audio-to-audio                               */
/* -------------------------------------------------------------------------- */

/**
 * ── WHY THIS DEVIATES FROM v6 §3 ────────────────────────────────────────────
 *
 * v6 binds the Cloud Agent to OpenAI Realtime — one model, audio in, audio out.
 * No OpenAI key was obtainable, so the Fast Loop is now a CASCADE:
 *
 *     Agora ASR  →  Groq (chat completions)  →  TTS vendor
 *
 * Groq was verified against the live Agora API before this was written: Agora
 * accepts it as a custom LLM because the API is OpenAI-compatible with SSE.
 * Groq has no TTS and is not on Agora's vendor list, so the voice comes from
 * ElevenLabs or Sarvam.
 *
 * TWO CONSEQUENCES, BOTH REAL:
 *
 * 1. **§12.1's latency budget no longer applies.** The ≤800 ms mouth-to-ear
 *    figure explicitly assumed "no ASR→LLM→TTS cascade". We have reintroduced
 *    exactly that. Groq is the fastest inference available and ElevenLabs Flash
 *    is a low-latency model, so this may still land near ~1.5 s — but it must be
 *    MEASURED in S0, not assumed.
 *
 * 2. **`on_speaking_action: "interrupt"` is now an open question.** The whole
 *    Bridge (§5) depends on Echo being cut off mid-sentence. That behaviour was
 *    documented against the realtime path; here Echo is mid-TTS-playback, which
 *    is a different mechanism. This is the highest-risk unknown in the project
 *    and S0 exists to answer it.
 *
 * To go back to realtime the moment an OpenAI key appears, replace the `llm`
 * block below with `{ vendor: "openai", url: "wss://api.openai.com/v1/realtime",
 * model: "gpt-4o-realtime-preview", ... }` and drop `tts` entirely. Nothing
 * else in this file changes — the prompt, the tools and the VAD config are
 * identical either way.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const GROQ_CHAT_COMPLETIONS_URL =
  "https://api.groq.com/openai/v1/chat/completions";

/**
 * `gpt-oss-120b` over the smaller models: this prompt is long and the epistemic
 * rules are subtle, and §6 Rules 1–2 are PROMPT-enforced. A weaker model is
 * likelier to slip into diagnosing, which is the one failure the brief cannot
 * tolerate. The Tier 1 tripwires catch it in fixtures; on a live bridge only
 * the model's own discipline holds.
 */
export const FAST_LOOP_MODEL = "openai/gpt-oss-120b";

export type TtsVendor = "elevenlabs" | "sarvam";

export interface TtsSettings {
  vendor: TtsVendor;
  apiKey: string;
  /** ElevenLabs only. */
  voiceId?: string;
  /** Sarvam only. */
  speaker?: string;
  language?: string;
}

/**
 * Build the `tts` block.
 *
 * ⚠️ **Agora does not validate these parameter names.** A control probe against
 * the live API sent `{ totally_wrong_param_name: "x" }` and still got
 * `HTTP 200, RUNNING`. Agora checks only that `vendor` is one it knows; the
 * contents of `params` are forwarded to the vendor adapter unchecked.
 *
 * So a typo here does not fail loudly — it produces an agent that joins, looks
 * healthy, and is **silent forever**. If Echo ever goes quiet, suspect this
 * function before anything else.
 *
 * Note the asymmetry that makes that easy to trip over: ElevenLabs reads `key`,
 * Sarvam reads `api_subscription_key`.
 */
export function buildTtsConfig(tts: TtsSettings) {
  if (tts.vendor === "elevenlabs") {
    return {
      vendor: "elevenlabs",
      params: {
        key: tts.apiKey,
        // Flash over multilingual_v2: quality is a little lower, but we just
        // spent our latency budget on the cascade and cannot afford more.
        model_id: "eleven_flash_v2_5",
        voice_id: tts.voiceId ?? "pNInz6obpgDQGcFmaJgB",
        sample_rate: 24000,
      },
    };
  }

  return {
    vendor: "sarvam",
    params: {
      // NOT `key`. Sarvam's adapter reads `api_subscription_key`, and getting
      // this wrong yields a silent agent with no error anywhere. Proven: an
      // agent configured with `key` reached RUNNING and never made a sound,
      // while the same config with `api_subscription_key` spoke at 83%.
      api_subscription_key: tts.apiKey,

      // PIN THE MODEL. Do not rely on Agora's default.
      //
      // This bit us live: Agora's Sarvam adapter defaulted to `bulbul:v2`, and
      // Sarvam deprecated v2 mid-session. Agents that had been speaking went
      // silent — RUNNING, healthy, mute, no error on any surface. Sarvam only
      // says "Model 'bulbul:v2' has been deprecated" if you call it directly.
      //
      // An explicit model means a future deprecation shows up as a loud 400 on
      // our own probe rather than as a mysteriously silent demo.
      model: "bulbul:v3",

      // Speakers are model-scoped: v2 voices (anushka, abhilash…) are REJECTED
      // by v3. If you change the model, re-check the speaker — Sarvam returns
      // the compatible list in the error, which is how this one was found.
      speaker: tts.speaker ?? "anand",
      target_language_code: tts.language ?? "en-IN",
      pace: 1.0,
      sample_rate: 24000,
    },
  };
}

/**
 * Build the Conversational AI Engine create-agent payload.
 *
 * `idle_timeout` bounds a forgotten agent's spend. `silence_config` is off —
 * Echo's default state is silence, so a "say something if it goes quiet"
 * behaviour would directly contradict the WHEN TO SPEAK section above.
 */
/**
 * Where each tool actually lives on the Slow Loop.
 *
 * Agora REST tools are HTTP calls the Engine makes ITSELF, synchronously,
 * feeding the response straight back into the model's context. So this table
 * is the real seam between the voice agent and this product: the agent does
 * not receive incident state in its prompt, it goes and reads the Ledger.
 *
 * That is the whole reason Echo cannot invent an incident. Ask it what is
 * happening and it performs an HTTP GET against the same endpoint the
 * dashboard renders from.
 */
const TOOL_ROUTES: Record<string, { path: string; body: Record<string, unknown> }> = {
  query_incident_state: {
    path: "/tools/query_incident_state",
    // Only declared fields are sent, and `{{args.x}}` is substituted from the
    // model's tool call — so the model cannot smuggle extra fields through.
    body: { scope: "{{args.scope}}", entity: "{{args.entity}}" },
  },
  create_jira_ticket: {
    path: "/tools/invoke",
    body: {
      tool: "create_jira_ticket",
      summary: "{{args.summary}}",
      assigneeRole: "{{args.assigneeRole}}",
    },
  },
  post_slack_update: {
    path: "/tools/invoke",
    body: { tool: "post_slack_update", text: "{{args.text}}" },
  },
  page_oncall_team: {
    path: "/tools/invoke",
    body: { tool: "page_oncall_team", team: "{{args.team}}", reason: "{{args.reason}}" },
  },
  execute_runbook_script: {
    path: "/tools/invoke",
    body: {
      tool: "execute_runbook_script",
      runbook: "{{args.runbook}}",
      target: "{{args.target}}",
    },
  },
};

/**
 * The `tools` half of the llm block — or nothing at all.
 *
 * ── WHY NO TOOLS IS BETTER THAN BROKEN TOOLS ────────────────────────────────
 * Agora calls these URLs from its own servers. Without a publicly reachable
 * Slow Loop there is no URL that works, and a tool that always fails is worse
 * than an absent one: the model retries, collects errors, and falls back on
 * its own memory — producing exactly the confident, unsourced answer this
 * product exists to prevent.
 *
 * So when `AGENT_TOOL_BASE_URL` is unset the agent is created with tools
 * DISABLED. Echo can still hear, speak and be interrupted; it simply cannot
 * read the Ledger, and the console says so rather than letting it improvise.
 */
export function buildToolsBlock(toolBaseUrl: string | null) {
  if (!toolBaseUrl) return {};

  return {
    tools: AGENT_TOOLS.map(({ name, description, parameters }) => {
      const route = TOOL_ROUTES[name];
      return {
        // `type: "function"` combined with `server` is what declares a REST
        // tool. Omitting either is a 400 at create time.
        type: "function",
        function: { name, description, parameters },
        server: {
          method: "POST",
          url: `${toolBaseUrl}${route.path}`,
          headers: { "Content-Type": "application/json" },
          body: route.body,
          // The Ledger answers in milliseconds; a long timeout here would
          // leave the room in silence waiting on a call that already failed.
          timeout_ms: 8000,
        },
      };
    }),
  };
}

export function buildAgentPayload(params: {
  channel: string;
  agentUid: number;
  agentRtcToken: string;
  groqApiKey: string;
  tts: TtsSettings;
  /** Public base URL of the Slow Loop. Null disables tools — see above. */
  toolBaseUrl?: string | null;
}) {
  return {
    name: `echo-${params.channel}`,
    properties: {
      channel: params.channel,
      token: params.agentRtcToken,
      agent_rtc_uid: String(params.agentUid),
      // Subscribe to every human on the bridge. "*" rather than an enumerated
      // list so a late joiner is heard without reconfiguring the agent.
      remote_rtc_uids: ["*"],
      enable_string_uid: false,
      idle_timeout: 300,
      advanced_features: {
        enable_aivad: false,
        enable_rtm: true,
        // Tracks whether tools were ACTUALLY attached. Declaring tools the
        // Engine cannot reach is worse than declaring none: the model retries,
        // collects errors, and falls back on its own memory — the exact
        // hallucination this product exists to prevent.
        enable_tools: Boolean(params.toolBaseUrl),
      },

      /*
        Session parameters, matching the official quickstart's managed agent
        config verbatim (agent-quickstart docs, "Managed Agent Config").

        An earlier version of this file carried an invented `transcript: {…}`
        block, added while trying to work out why speech produced no claims.
        It was a guess at a vendor API, Agora accepted the payload without
        understanding it — the same 200-means-parsed trap already documented
        for `tts.params` — and it changed nothing. Removed.

        The actual cause was on our side: transcripts arrive on the RTC DATA
        STREAM, and the console was listening only to RTM. See
        `lib/agora/voice-agent.ts`.
      */
      parameters: {
        // The official quickstart's profile for browser clients.
        audio_scenario: "chorus",
        data_channel: "rtm",
        enable_metrics: true,
        // Surfaced rather than swallowed: a silent agent is the hardest
        // failure to diagnose here, and this is the channel that says why.
        enable_error_message: true,
      },
      turn_detection: TURN_DETECTION,
      llm: {
        // No `vendor` field: this is Agora's CUSTOM LLM path, which is selected
        // by giving a URL it does not recognise as a first-party vendor. The
        // endpoint must be OpenAI-chat-completions compatible and support SSE.
        url: GROQ_CHAT_COMPLETIONS_URL,
        api_key: params.groqApiKey,
        model: FAST_LOOP_MODEL,
        system_messages: [
          { role: "system", content: FAST_LOOP_SYSTEM_PROMPT },
        ],
        ...buildToolsBlock(params.toolBaseUrl ?? null),
        max_history: 32,
        greeting_message: "",
      },
      // Echo's voice. MANDATORY in cascaded mode — an agent without a `tts`
      // block is rejected outright with `properties: tts.addon not found`.
      // (Verified, not assumed: see session_log.md.)
      tts: buildTtsConfig(params.tts),
      /*
        ── SPEECH-TO-TEXT, AND THE FIELD WHOSE ABSENCE MADE ECHO DEAF ────────
        This block used to be `{ language, keywords: [...] }`. It has no
        `vendor`, and without one Agora runs no recogniser at all — so speech
        reached the channel, the agent sat in it, and not one word was ever
        transcribed. Silently: the payload returns 200 because Agora validates
        that `vendor` is one it knows and forwards `params` unchecked, exactly
        as documented for `tts` above.

        The shape below is not a guess. It is what the official SDK emits —
        `agora_agent/agentkit/vendors/stt.py` builds `{vendor, params}`, and
        `agent.py::_resolve_asr_config` injects `language` from turn detection
        and defaults `vendor` when none is given. Verified by reading the
        installed package rather than by trying key names against the API.

        `nova-3` is an AGORA-MANAGED model: no Deepgram key is required, which
        is what the hackathon organisers pointed at for teams without their own
        provider keys.
      */
      asr: {
        vendor: "deepgram",
        params: {
          model: "nova-3",
          // `keyterm`, NOT `keywords` — the latter is not a Deepgram option and
          // was silently discarded. Biasing matters here: without it "Redis"
          // reliably becomes "read us", and extraction then invents an entity
          // nobody mentioned.
          keyterm: "Redis Datadog checkout eviction latency replica failover Sev-1",
          smart_format: true,
          punctuation: true,
        },
        // Kept in step with turn_detection deliberately. The SDK treats turn
        // detection as the single source of truth for interaction language and
        // OVERWRITES this field; a mismatch here would be silently discarded.
        language: TURN_DETECTION.language,
      },
    },
  };
}
