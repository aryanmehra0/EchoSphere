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

[WHEN THE USER IS SILENT OR UNINTELLIGIBLE]
The recogniser fires on more than speech — a cough, ambient noise, faint audio —
so you will sometimes be invoked with an EMPTY or unreadable transcription.
That is not a turn to answer. If the user's message contains no recognisable
words, respond with NOTHING: no words, no punctuation, and above all no
placeholder. Never write "[Silence]", "[Pause]", "...", or any text that
narrates or describes your own silence — that text is read ALOUD. A blank
response is the correct response, and it is never turned into speech.

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
 * What to append when the agent is created WITHOUT tools.
 *
 * ── WHY THIS IS NOT OPTIONAL ────────────────────────────────────────────────
 * Rule 3 tells the model to answer factual questions by calling
 * `query_incident_state`. When `AGENT_TOOL_BASE_URL` is unset that tool is not
 * in the payload at all — so the model is under a hard instruction to use an
 * instrument it does not have.
 *
 * A model in that position does one of two things, and both are bad: it goes
 * silent (which reads as a broken agent), or it decides the rule cannot have
 * meant this and answers from memory (which is the unsourced confident answer
 * this whole product exists to prevent).
 *
 * Naming the situation removes the bind. Echo can still hear, still speak,
 * still take a direct question — it simply says what it cannot do. "I can't
 * read the record right now" is a true sentence and an acceptable answer;
 * inventing the record is not.
 */
export const NO_TOOLS_ADDENDUM = `

[THE RECORD IS NOT READABLE RIGHT NOW]
Your query_incident_state tool is unavailable in this session. This does NOT
relax Rule 3 — it means you cannot satisfy it, so you must say so.

When asked anything factual about this incident:
  "I can't read the incident record from here, so I won't guess at it.
   It's on the dashboard."
Then stop. Do not reconstruct the incident from what you have overheard, and
do not summarise it. Overhearing is not the record.

You MAY still, without the tool:
  - answer who and what you are, and what you do
  - confirm you are listening and recording
  - repeat back what someone just said, attributed to them, to check it
  - state that a decision needs dashboard approval

Being unable to answer is not a failure. Answering wrongly is.`;

/**
 * The conversational prompt — the quickstart's posture, in Echo's role.
 *
 * ── WHY THIS EXISTS, AND WHAT IT COST TO FIND ───────────────────────────────
 * With the pipeline finally listening (ASR transcribed "Are you listening?
 * Hello? Hello?" perfectly), Echo still said NOTHING. That was not a bug. It
 * was `FAST_LOOP_SYSTEM_PROMPT` doing exactly what it says, three times over:
 *
 *   - "[WHEN TO SPEAK — default is ABSOLUTE SILENCE] ... 1. DIRECT INVOCATION
 *     — a human says your name."   "Hello" contains no name, so: silence.
 *   - "You do not greet, acknowledge, back-channel, or fill silence."
 *     So no greeting on join, ever.
 *   - Rule 3, "NEVER ANSWER FROM MEMORY", requires `query_incident_state` —
 *     and with no tunnel there are no tools, so factual questions cannot be
 *     answered either.
 *
 * Three independent gags, each individually correct for a live Sev-1 bridge
 * and collectively indistinguishable from a broken agent. The quickstart's Ada
 * prompt has none of them, which is precisely why the quickstart "just talks".
 *
 * So the posture is now selectable. This is the DEFAULT because an agent that
 * answers when spoken to is the thing you check first; the disciplined prompt
 * is what you switch on to demonstrate the epistemic guarantees.
 *
 *     AGENT_PROMPT_MODE=incident   the v6 §14.1 rules (silence by default)
 *     AGENT_PROMPT_MODE=conversational   this one (default)
 */
export const CONVERSATIONAL_SYSTEM_PROMPT = `You are "Echo", an AI assistant sitting on a live incident bridge.

Be clinical, calm and brief — one or two sentences unless asked for more.

You are a recording secretary, not a diagnostician. When you state something
that someone on the bridge said, attribute it to them. Do not assert what
caused an outage; if you do not know something, say so plainly rather than
guessing.

Answer whenever someone speaks to you. You do not need to be addressed by
name.`;

/** The greeting Echo speaks on joining, when the LLM owns the greeting. */
export const DEFAULT_GREETING =
  "Echo is on the bridge and recording. Ask me what we know so far.";

export type PromptMode = "incident" | "conversational";

export function promptMode(): PromptMode {
  return process.env.AGENT_PROMPT_MODE?.trim() === "incident"
    ? "incident"
    : "conversational";
}

/**
 * The system prompt actually sent, given whether tools survived configuration.
 *
 * Kept separate from FAST_LOOP_SYSTEM_PROMPT because the test suite asserts
 * against that constant directly — the epistemic rules must stay greppable and
 * diffable, not assembled at runtime out of fragments.
 */
export function buildSystemPrompt(
  toolsEnabled: boolean,
  mode: PromptMode = promptMode(),
): string {
  if (mode === "conversational") return CONVERSATIONAL_SYSTEM_PROMPT;
  return toolsEnabled
    ? FAST_LOOP_SYSTEM_PROMPT
    : FAST_LOOP_SYSTEM_PROMPT + NO_TOOLS_ADDENDUM;
}

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

/**
 * The model on the Agora-managed path.
 *
 * Copied from the official quickstart's `OpenAI(model="gpt-4o-mini")`, which
 * carries no api_key - Agora supplies and bills it. Same string, so a reader
 * comparing the two files sees they agree.
 */
export const MANAGED_FAST_LOOP_MODEL = "gpt-4o-mini";

/**
 * Sent even on the managed path. `OpenAI.to_config()` always emits a url and
 * only conditionally emits `api_key`; omitting the url is not how managed
 * mode is expressed.
 */
export const MANAGED_OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/** Terms this incident actually uses, boosted for the recogniser. */
export const ASR_KEYTERMS =
  "Redis Datadog checkout eviction latency replica failover Sev-1";

/**
 * The `preset` string, composed the way `presets.py:resolve_session_presets`
 * composes it: one entry per managed category, comma-joined.
 *
 * ASR is always managed here (Agora supplies nova-3). The LLM entry appears
 * only in managed mode - on the Groq path we send our own url and key, and
 * `infer_llm_preset` returns null for anything carrying an `api_key`.
 * ElevenLabs TTS is BYOK, so it never contributes a preset.
 */
/**
 * ── PRESET RESOLUTION, PORTED FROM THE SDK ──────────────────────────────────
 *
 * This replaces a hand-written `preset` string, and the distinction is the
 * whole bug it fixes.
 *
 * A preset is NOT a thing you assert alongside a vendor block. In the SDK it is
 * DERIVED from one, and the fields it covers are then removed:
 *
 *     agentkit/presets.py::resolve_session_presets(preset, properties)
 *       -> infer_asr_preset / infer_llm_preset / infer_tts_preset
 *       -> strip_inferred_preset_fields(properties, inferred)
 *
 * `infer_asr_preset` reads `asr.params.model` and maps "nova-3" ->
 * `deepgram_nova_3`. `strip_inferred_preset_fields` then deletes that same
 * `params.model`. Order matters absolutely: infer FIRST from a fully populated
 * block, strip SECOND.
 *
 * We were doing neither. `buildPreset()` hardcoded "deepgram_nova_3,
 * openai_gpt_4o_mini" while the vendor blocks were already pre-stripped — no
 * `asr.params.model`, no `llm.url`, no `llm.params.model`. So we claimed two
 * managed presets on the strength of blocks that never justified either one,
 * and Agora returned 200 with an agent that joined, subscribed correctly, and
 * neither transcribed nor answered.
 *
 * Below is a faithful port. Build blocks FULL, then resolve. The exported
 * helpers keep their old signatures so existing tests and `dump-payload.mjs`
 * keep working.
 * ────────────────────────────────────────────────────────────────────────────
 */

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

const DEEPGRAM_MODEL_TO_PRESET: Record<string, string> = {
  "nova-2": "deepgram_nova_2",
  "nova-3": "deepgram_nova_3",
};

const OPENAI_MODEL_TO_PRESET: Record<string, string> = {
  "gpt-4o-mini": "openai_gpt_4o_mini",
  "gpt-4.1-mini": "openai_gpt_4_1_mini",
  "gpt-5-nano": "openai_gpt_5_nano",
  "gpt-5-mini": "openai_gpt_5_mini",
};

const PRESET_CATEGORY: Record<string, "asr" | "llm" | "tts"> = {
  deepgram_nova_2: "asr",
  deepgram_nova_3: "asr",
  openai_gpt_4o_mini: "llm",
  openai_gpt_4_1_mini: "llm",
  openai_gpt_5_nano: "llm",
  openai_gpt_5_mini: "llm",
  minimax_speech_2_6_turbo: "tts",
  minimax_speech_2_8_turbo: "tts",
  openai_tts_1: "tts",
};

type Block = Record<string, unknown>;

function normalizeModelName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function paramsOf(block: Block | undefined): Block {
  const p = block?.params;
  return p && typeof p === "object" ? (p as Block) : {};
}

/**
 * `presets.py::infer_asr_preset`. Returns null when a `key` is present —
 * BYOK and a managed preset are mutually exclusive by construction.
 */
export function inferAsrPreset(asr: Block | undefined): string | null {
  if (!asr || asr.vendor !== "deepgram") return null;
  const params = paramsOf(asr);
  if (params.key) return null;
  return DEEPGRAM_MODEL_TO_PRESET[normalizeModelName(params.model)] ?? null;
}

/**
 * `presets.py::infer_llm_preset`. Note the `api_key` guard: a stray key drops
 * the agent off the managed path silently, which is why the Groq branch never
 * yields an LLM preset.
 */
export function inferLlmPreset(llm: Block | undefined): string | null {
  if (!llm || llm.api_key) return null;
  if (llm.vendor !== undefined && llm.vendor !== "openai") return null;
  if (llm.url !== undefined && llm.url !== OPENAI_CHAT_COMPLETIONS_URL) return null;
  return OPENAI_MODEL_TO_PRESET[normalizeModelName(paramsOf(llm).model)] ?? null;
}

function omitNone(value: Block): Block | undefined {
  const next: Block = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && v !== undefined) next[k] = v;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * `presets.py::strip_inferred_preset_fields`, ASR + LLM only (our TTS is
 * always BYOK, so it contributes no preset and keeps every field).
 *
 * Removes exactly what the inferred preset already carries — and NOTHING
 * else. `params.language` is deliberately kept for ASR, matching the SDK.
 */
function stripInferredPresetFields(
  properties: Block,
  inferred: readonly string[],
): Block {
  const categories = new Set(
    inferred.map((p) => PRESET_CATEGORY[p]).filter(Boolean),
  );
  const next: Block = { ...properties };

  const asr = properties.asr as Block | undefined;
  if (asr && categories.has("asr")) {
    const params: Block = { ...paramsOf(asr) };
    if (inferAsrPreset(asr) === DEEPGRAM_MODEL_TO_PRESET[normalizeModelName(params.model)]) {
      delete params.model;
    }
    delete params.api_key;
    next.asr = { ...asr, params: omitNone(params) };
  }

  const llm = properties.llm as Block | undefined;
  if (llm && categories.has("llm")) {
    const params: Block = { ...paramsOf(llm) };
    if (inferLlmPreset(llm) === OPENAI_MODEL_TO_PRESET[normalizeModelName(params.model)]) {
      delete params.model;
    }
    const rest: Block = { ...llm };
    delete rest.api_key;
    delete rest.url;
    delete rest.params;
    // The OpenAI url is implied by the preset; a non-default url is kept.
    const url = llm.url;
    if (url && url !== OPENAI_CHAT_COMPLETIONS_URL) rest.url = url;
    const kept = omitNone(params);
    if (kept) rest.params = kept;
    next.llm = rest;
  }

  return next;
}

/**
 * `presets.py::resolve_session_presets`. Explicit presets win per category;
 * anything not named explicitly is inferred from the vendor blocks.
 */
export function resolveSessionPresets<T extends Block>(properties: T): {
  preset: string | null;
  properties: T;
} {
  const inferred: string[] = [];
  const asrPreset = inferAsrPreset(properties.asr as Block | undefined);
  if (asrPreset) inferred.push(asrPreset);
  const llmPreset = inferLlmPreset(properties.llm as Block | undefined);
  if (llmPreset) inferred.push(llmPreset);

  return {
    preset: inferred.length > 0 ? inferred.join(",") : null,
    // The strip only ever deletes preset-covered vendor sub-fields, so the
    // caller's shape is preserved for type purposes.
    properties: stripInferredPresetFields(properties, inferred) as T,
  };
}

/**
 * Kept for callers that only want the string (tests, dump-payload). The
 * payload builder no longer uses it — see `resolveSessionPresets`.
 */
export function buildPreset(mode: LlmMode): string {
  const presets = ["deepgram_nova_3"];
  if (mode === "managed") presets.push("openai_gpt_4o_mini");
  return presets.join(",");
}

/** Models Agora will supply a credential for. From the SDK's own allowlist. */
export const MANAGED_MODELS = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-nano", "gpt-5-mini"];

export type LlmMode = "managed" | "groq";

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
        // `||`, not `??`. A blank ELEVENLABS_VOICE_ID reaches here as "" on
        // any path that does not go through `optional()`, and an empty
        // voice_id is another silent-agent failure of exactly the kind this
        // function's header warns about.
        voice_id: tts.voiceId || "pNInz6obpgDQGcFmaJgB",
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
/**
 * The vendor half of the `llm` block.
 *
 * Declared with one shape rather than a discriminated union so that callers -
 * and the test suite - can read `llm.url` without narrowing first. The fields
 * that do not apply to a mode are simply absent at runtime, which is what
 * Agora expects.
 */
export interface LlmVendorBlock {
  url?: string;
  api_key?: string;
  vendor?: string;
  style?: string;
  params: {
    /**
     * Absent on the managed path: `strip_inferred_preset_fields` removes it
     * once the preset has been inferred from it, so the preset carries the
     * model and sending it again would be redundant at best.
     */
    model?: string;
    max_tokens: number;
    temperature: number;
    top_p?: number;
  };
}

export function buildLlmVendor(
  mode: LlmMode,
  groqApiKey: string,
  groqModel: string,
): LlmVendorBlock {
  if (mode === "managed") {
    /*
      ── READ OFF THE SDK, NOT GUESSED ───────────────────────────────────────
      `agora_agent/agentkit/vendors/llm.py`, `OpenAI.to_config()`. Managed mode
      is NOT "omit the vendor block" and it is NOT `vendor: "openai"`:

        config = { url: base_url or "https://api.openai.com/v1/chat/completions",
                   params, style: "openai", input_modalities }
        if api_key is not None: config["api_key"] = api_key

      So the OpenAI URL is ALWAYS sent; managed differs only by leaving
      `api_key` out, and Agora then supplies and bills the credential. The
      validator is explicit about the two traps:

        "OpenAI Agora-managed mode does not allow vendor"
        "OpenAI requires api_key unless using a supported Agora-managed model"

      The first version of this function sent `vendor: "openai"` with no url,
      which is exactly the combination the SDK forbids - Agora returned 200
      RUNNING and the LLM leg never ran, which is this API's signature
      failure mode.

      The allowlist is `{gpt-4o-mini, gpt-4.1-mini, gpt-5-nano, gpt-5-mini}`;
      anything else needs a key of our own.
    */
    /*
      No url, no api_key, no model - the preset carries all three.

      `to_config()` emits the OpenAI url, but the session layer then runs
      `strip_inferred_preset_fields()`, which removes `url`, `api_key` and
      `params.model` once `openai_gpt_4o_mini` has been inferred from them.
      What reaches the wire is only what the preset does NOT cover.

      Sending them anyway is not harmless: `infer_llm_preset` returns null for
      any llm block carrying an `api_key`, so a stray key silently drops the
      agent off the managed path entirely.
    */
    /*
      FULL block, NOT pre-stripped. `resolveSessionPresets` needs `url` and
      `params.model` present to infer `openai_gpt_4o_mini`; it removes both
      immediately afterwards. Omitting them here (the previous behaviour)
      meant nothing could be inferred, so the hardcoded preset was asserted
      against a block that did not support it and the LLM leg never ran.

      Still no `api_key` — that is what "managed" means, and `infer_llm_preset`
      returns null for any block carrying one.
    */
    return {
      url: MANAGED_OPENAI_URL,
      style: "openai",
      params: {
        model: MANAGED_FAST_LOOP_MODEL,
        max_tokens: 1024,
        temperature: 0.7,
        top_p: 0.95,
      },
    };
  }

  return {
    url: GROQ_CHAT_COMPLETIONS_URL,
    api_key: groqApiKey,
    // `style` selects the chat-completions dialect; Groq is OpenAI-compatible,
    // which is the only reason a custom URL works at all.
    style: "openai",
    params: {
      // The model lives INSIDE params. A top-level `model` is an unknown key
      // that Agora forwards untouched, so the request reached Groq with no
      // model, the turn never completed, and no transcript was ever emitted.
      model: groqModel,
      // Echo's turns are short by design (§14.1 DELIVERY: under 15 seconds);
      // a long ceiling only buys latency on a live bridge.
      max_tokens: 512,
      temperature: 0.3,
    },
  };
}

export function buildToolsBlock(
  toolBaseUrl: string | null,
  toolSecret: string | null = null,
) {
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
          // The token the backend's tunnel gate checks. Without it every
          // tool call comes back 401 and Echo cannot read the Ledger — which
          // looks exactly like the model refusing to answer.
          headers: {
            "Content-Type": "application/json",
            ...(toolSecret ? { "X-Echo-Tool-Token": toolSecret } : {}),
          },
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
  /**
   * The human the agent subscribes to. Agora supports exactly one — see
   * `remote_rtc_uids` below, and do not pass a wildcard.
   */
  userUid: number;
  agentRtcToken: string;
  groqApiKey: string;
  /**
   * Chosen at invite time by `selectFastLoopModel`, because the daily budget
   * is per key AND per model and Agora's payload carries only one of each.
   * Defaults to the primary.
   */
  groqModel?: string;
  tts: TtsSettings;
  /** Public base URL of the Slow Loop. Null disables tools — see above. */
  toolBaseUrl?: string | null;
  /** Shared secret for the backend's tunnel gate. */
  toolSecret?: string | null;
  /**
   * Which Fast Loop to build. "managed" reproduces the quickstart chain
   * (Agora supplies the model); "groq" keeps our own pinned model and key.
   */
  llmMode?: LlmMode;
}) {
  const properties = {
      channel: params.channel,
      token: params.agentRtcToken,
      agent_rtc_uid: String(params.agentUid),
      /*
        ── THE AGENT HEARS EXACTLY ONE PERSON, AND "*" IS NOT A WILDCARD ─────
        This was `["*"]`, with a comment claiming it subscribed to everyone so
        late joiners would be heard. That is not what the field does. The
        schema is unambiguous:

          "A list of user IDs that the agent subscribes to in the channel.
           Only subscribed users can interact with the agent. Currently, only
           one user ID is supported."

        So `"*"` was read as a user ID literally named `*`, which nobody has.
        The agent therefore subscribed to NOBODY: it joined, sat in the
        channel, heard silence, and produced no transcripts — with the create
        call returning 200 the whole time, because the value is well-formed
        even though it matches no one.

        ⚠️ ARCHITECTURAL CONSEQUENCE, and it is not a small one. Agora's
        Conversational AI Engine listens to ONE human. §18's two-machine
        requirement still holds for the DASHBOARD — both consoles forward
        their own speech to the Slow Loop over their own RTC connection — but
        Echo's own ears are on a single participant. Whoever is subscribed
        here is the person Echo can converse with; the second speaker's words
        still reach the Ledger, they just do not reach the agent's STT.
      */
      remote_rtc_uids: [String(params.userUid)],
      enable_string_uid: false,
      idle_timeout: 300,
      advanced_features: {
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
        /*
          ── THE MODEL GOES IN `params`, NOT AT THE TOP LEVEL ────────────────
          This block used to carry `model: FAST_LOOP_MODEL` as a sibling of
          `url`. The SDK's own serialiser
          (`agentkit/vendors/llm.py::OpenAI.to_config`) shows the wire shape is

              { url, api_key, params: { model, ...}, style, input_modalities }

          — the model lives inside `params`, and there is a `style` field
          naming the request dialect. A top-level `model` is simply an unknown
          key, and Agora forwards unknown keys untouched, so the request went
          to Groq WITHOUT a model. Groq rejects that, the LLM turn never
          completes, and a pipeline that never completes a turn emits no
          transcript.

          Which is exactly the shape of the bug: `/bridge/say` kept working
          throughout, because speaking a supplied line bypasses the LLM
          entirely. Echo could talk and could not listen.

          `style: "openai"` selects the chat-completions dialect; Groq is
          OpenAI-compatible, which is why this custom URL works at all.
        */
        /*
          ── MANAGED vs BYOK, AND WHY BOTH EXIST ─────────────────────────────
          `AGENT_LLM_MODE=managed` reproduces the official quickstart's chain
          exactly: `OpenAI(model="gpt-4o-mini")` with NO api_key, which means
          Agora supplies and bills the model. That removes the constraint that
          sent this project to Groq in the first place - no OpenAI key was
          obtainable, and on the managed path none is needed.

          It matters because a custom `llm.url` is the one leg of the pipeline
          that has never been observed to complete a turn here. Every line
          Echo has ever spoken arrived through `/speak` with
          `start_type: "api_speak"` - pushed by us. The single trace of the
          Fast Loop model running was Agora's `failure_message`.

          Keeping BOTH is deliberate. Managed is the known-good path and the
          one the brief asks to demonstrate; Groq keeps the epistemic rules on
          a model we pin ourselves, and costs nothing. Switch with one env var
          and nothing else in this file changes - same prompt, same tools,
          same VAD.
        */
        ...buildLlmVendor(params.llmMode ?? "groq", params.groqApiKey,
                          params.groqModel ?? FAST_LOOP_MODEL),
        input_modalities: ["text"],
        system_messages: [
          {
            role: "system",
            /*
              PINNED to the incident prompt, deliberately.

              `buildAgentPayload` is the legacy hand-built path; the live agent
              is now created by the SDK in `backend/app/voice_agent.py`, which
              takes its prompt from the invite route. This function survives
              only for the tests that assert the v6 §14.1 rules are intact and
              greppable, so it must keep returning them regardless of what
              AGENT_PROMPT_MODE says about the running console.
            */
            content: buildSystemPrompt(Boolean(params.toolBaseUrl), "incident"),
          },
        ],
        ...buildToolsBlock(params.toolBaseUrl ?? null, params.toolSecret ?? null),
        max_history: 32,
        // Echo's arrival line is composed by the Slow Loop and spoken through
        // `/speak` (see `utterance.joined`), NOT here. This field makes the
        // MODEL write the greeting, and the model is the component §6 does
        // not trust to speak unsupervised.
        greeting_message: "",
        /*
          ── EMPTY ON PURPOSE, AND IT IS NOT COSMETIC ────────────────────────
          This was "One moment.", and a live run recorded Echo saying it five
          times into an otherwise silent channel.

          The cause is the prompt working correctly. Agora's recogniser emits
          turns for non-speech, so the model is invoked with an empty user
          message; under "[WHEN TO SPEAK — default is ABSOLUTE SILENCE]" it
          returns nothing, which is exactly right. Agora reads an empty
          completion as a failure and speaks this field.

          So the better the model obeys §14.1, the more filler Echo produces —
          and "No filler. Never 'Got it', 'Sure'" is in the same prompt. On a
          real bridge an assistant that interjects at every cough gets muted,
          which ends the demo.

          Empty means a silent turn stays silent. A genuine LLM outage is
          still visible — `voiceVerified` on the invite response and the
          pre-flight's "Echo can answer out loud" both report it, and neither
          requires anyone to notice a phrase in a busy room.

          ⚠️ THE SAME HOLE, MOVED INTO THE MODEL. Sep 05: the managed path
          (gpt-4o-mini) answered an empty ASR turn with the literal text
          "[Silence] " — and Agora's history shows it read that placeholder
          ALOUD, on repeat, for a full minute (turns 2, 3, 4, 5, 7, 8, 9, 11…18,
          each preceded by a `user` turn of `content: ""` from VAD noise). The
          engine's filler was closed, and the model grew its own. Countered in
          the prompt's "[WHEN THE USER IS SILENT OR UNINTELLIGIBLE]" section:
          a blank response on empty input is never read aloud. Keep that rule;
          if Echo "repeats silence" again, check this empty-completion path
          first.
        */
        failure_message: "",
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
      /*
        ── EVERY DEEPGRAM SETTING LIVES INSIDE `params` ────────────────────────
        Read off the SDK, `vendors/stt.py`, `DeepgramSTT.to_config()`:

            params = {}
            if model:        params["model"]    = model
            if language:     params["language"] = language
            ...
            return {"vendor": "deepgram", "params": params}

        This block previously carried `language` as a SIBLING of `params` and
        no `model` at all, relying on the top-level `preset` to supply the
        model. Both are wrong, and both fail silently:

          - Agora forwards unknown keys untouched, so a misplaced `language`
            is not rejected - it is simply never given to Deepgram.
          - `presets.py:infer_asr_preset()` DERIVES the preset FROM
            `params.model`. The preset is a consequence of the model, not a
            replacement for it.

        The observed symptom is exactly what that predicts, and it is the one
        a room notices: VAD segments the turn, Agora records a `user` turn
        with `source: "asr"`, and `content` comes back EMPTY. The agent looks
        like it is listening and hears nothing.

        `strip_inferred_preset_fields()` then removes `params.model` once the
        preset covers it, and explicitly KEEPS `params.language` - which is
        why language belongs here and the model does not need to.

        `en` rather than `en-US`, matching the quickstart's
        `DeepgramSTT(model="nova-3", language="en")`.
      */
      asr: {
        vendor: "deepgram",
        params: {
          /*
            REQUIRED so `inferAsrPreset` can map nova-3 -> `deepgram_nova_3`.
            `stripInferredPresetFields` deletes it again straight afterwards,
            so it never reaches the wire — but without it here, nothing is
            inferred and the managed recogniser is never activated. That was
            the deaf agent: VAD segmented turns, `source: "asr"`, content "".

            No `key`: nova-3 is Agora-managed, and a key would make
            `inferAsrPreset` return null.
          */
          model: "nova-3",
          // Domain vocabulary. An incident bridge says "Redis" and "Datadog"
          // far more often than general English does, and Deepgram scores
          // these terms higher when they are named.
          keyterm: ASR_KEYTERMS,
          smart_format: true,
          punctuation: true,
        },
        // TOP LEVEL, and equal to turn_detection.language. `agent.py`:
        //
        //   # Unconditional: turn detection is the single source of truth for
        //   # the interaction language, so a vendor-level `language` would be
        //   # silently discarded here.
        //   asr_config["language"] = field(turn_detection_config, "language")
        //
        // A previous edit moved this into `params` on the strength of
        // `DeepgramSTT.to_config()`, which does put it there - but the session
        // layer overwrites it from turn detection afterwards, so params is
        // exactly where it gets thrown away.
        language: TURN_DETECTION.language,
      },
  };

  /*
    DERIVE the preset from the blocks above, then strip what it covers.
    This is `resolve_session_presets` — the step the SDK runs and we used
    to skip. Asserting a preset next to pre-stripped blocks is what left
    Echo joined-but-deaf on a 200 response.
  */
  const resolved = resolveSessionPresets(properties);

  return {
    name: `echo-${params.channel}`,
    ...(resolved.preset ? { preset: resolved.preset } : {}),
    properties: resolved.properties,
  };
}
