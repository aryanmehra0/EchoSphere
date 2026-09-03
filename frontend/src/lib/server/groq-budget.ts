import "server-only";

import { FAST_LOOP_MODEL, GROQ_CHAT_COMPLETIONS_URL } from "./agent-config";
import { serverEnv } from "./env";

/**
 * Pick a Groq key and model that can actually answer, before handing them to
 * Agora.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * The Slow Loop rotates across every configured key (`groq_api_keys()` in
 * `backend/app/config.py`). The Fast Loop cannot: Agora's create-agent payload
 * carries exactly ONE `llm.api_key`, and Agora calls Groq itself, so there is
 * nothing of ours in the loop to retry with a different one.
 *
 * The two behaviours diverge exactly when it hurts. Groq's free tier is
 * 200,000 tokens per day, scoped per key and per model. When the first key's
 * budget runs out the Slow Loop shrugs and rotates — claims keep appearing,
 * the dashboard keeps filling, the pre-flight keeps saying GO because it asks
 * `groq_json`, which also rotates. Meanwhile every Fast Loop turn 429s, and
 * Agora responds by speaking its `failure_message`.
 *
 * Observed live on Sep 3: Echo answered two spoken turns with "One moment."
 * and nothing else, while `/health/model` reported all three models available
 * and the pre-flight printed a clean GO. Nothing in the system was wrong
 * except that Agora had been handed the one key with no budget left.
 *
 * So this asks the question Agora will ask, in the form Agora will ask it, and
 * hands over a pair that answered.
 */

/**
 * Reserve what a real turn reserves.
 *
 * Groq bills against RESERVED `max_tokens`, not tokens used, so a probe with
 * `max_tokens: 16` is not a test of anything a conversation needs — it fits in
 * budget that a real turn does not. That asymmetry is what let the pre-flight
 * report "available" against a key with roughly two hundred tokens left.
 */
const PROBE_MAX_TOKENS = 512;

export interface FastLoopModel {
  apiKey: string;
  model: string;
  /** 1-based, for logs and the invite response. Never the key itself. */
  keyIndex: number;
  /** False when nothing answered — the agent is created, but will be mute. */
  verified: boolean;
  detail?: string;
}

/** Every configured key, in preference order, deduplicated. */
function keys(): string[] {
  const out: string[] = [];
  for (const name of ["GROQ_API_KEY", "GROQ_API_KEY_2", "GROQ_API_KEY_3"]) {
    const value = process.env[name]?.trim();
    // Deduplicated because pasting the same key into two slots is an easy
    // mistake that would otherwise look like redundancy while providing none.
    if (value && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [serverEnv.groqApiKey];
}

async function answers(apiKey: string, model: string): Promise<true | string> {
  try {
    const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        max_tokens: PROBE_MAX_TOKENS,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (response.ok) return true;

    // The daily cap appears ONLY in the 429 body — Groq's rate-limit headers
    // report the per-minute window, so a header check would miss it entirely.
    const body = await response.text();
    return `${response.status} ${body.slice(0, 200)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The first (key, model) pair that answers, preferring the primary model on
 * the primary key.
 *
 * Ordered key-outer so a healthy key keeps the better model rather than
 * dropping to a weaker one the moment the primary key is spent — §14.1's
 * epistemic rules are prompt-enforced in the Fast Loop, and a weaker model
 * slips into diagnosing more readily, which is the one failure the brief
 * cannot tolerate.
 */
export async function selectFastLoopModel(
  fallbackModels: string[] = ["openai/gpt-oss-20b"],
): Promise<FastLoopModel> {
  const candidates = [FAST_LOOP_MODEL, ...fallbackModels];
  const available = keys();
  const failures: string[] = [];

  for (const [index, apiKey] of available.entries()) {
    for (const model of candidates) {
      const result = await answers(apiKey, model);
      if (result === true) {
        return { apiKey, model, keyIndex: index + 1, verified: true };
      }
      failures.push(`key#${index + 1} ${model}: ${result}`);
    }
  }

  // Every pair failed. Create the agent anyway — S13 degradation: a mute Echo
  // with a working dashboard is still a demonstrable system, and tearing the
  // invite down would take the rest of the product with it. But say so, so
  // "Echo isn't answering" is a reported state rather than a mystery.
  return {
    apiKey: available[0],
    model: FAST_LOOP_MODEL,
    keyIndex: 1,
    verified: false,
    detail: failures.join(" | ").slice(0, 500),
  };
}
