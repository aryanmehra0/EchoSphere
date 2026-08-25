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
  mode: "agora_vad",
  interrupt_duration_ms: 300,
  prefix_padding_ms: 800,
  silence_duration_ms: 640,
  threshold: 0.5,
  language: "en-US",
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

/**
 * Build the Conversational AI Engine create-agent payload.
 *
 * `idle_timeout` bounds a forgotten agent's spend. `silence_config` is off —
 * Echo's default state is silence, so a "say something if it goes quiet"
 * behaviour would directly contradict the WHEN TO SPEAK section above.
 */
export function buildAgentPayload(params: {
  channel: string;
  agentUid: number;
  agentRtcToken: string;
  openAiApiKey: string;
  toolWebhookUrl?: string;
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
      },
      turn_detection: TURN_DETECTION,
      llm: {
        vendor: "openai",
        url: "wss://api.openai.com/v1/realtime",
        api_key: params.openAiApiKey,
        model: "gpt-4o-realtime-preview",
        system_messages: [
          { role: "system", content: FAST_LOOP_SYSTEM_PROMPT },
        ],
        tools: AGENT_TOOLS.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
        ...(params.toolWebhookUrl ? { tool_webhook: params.toolWebhookUrl } : {}),
        max_history: 32,
        greeting_message: "",
      },
      asr: {
        language: "en-US",
        // Biasing the recogniser toward the vocabulary of this incident.
        // Without it "Redis" reliably becomes "read us" and the extraction
        // model then invents an entity that nobody mentioned.
        keywords: [
          "Redis",
          "Datadog",
          "VPC",
          "us-east-1a",
          "us-east-1b",
          "checkout",
          "failover",
          "eviction",
          "latency",
          "packet loss",
          "replica",
          "Sev-1",
        ],
      },
    },
  };
}
