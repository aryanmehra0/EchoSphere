import "server-only";

/**
 * Zone 2 credentials — v6 §10.1.
 *
 * The `server-only` import at the top is load-bearing, not decorative. If any
 * client component ever transitively imports this module, the BUILD FAILS.
 * That turns "don't leak the app certificate to the browser" from a code-review
 * convention into a compiler error, which is the only version of that rule that
 * survives a hackathon sprint at 2am.
 *
 * Trust zones:
 *   Zone 1  browser    — short-TTL Agora tokens ONLY, never app credentials
 *   Zone 2  Next.js    — this file. Agora app id + certificate.
 *   Zone 3  Python     — LLM / STT / Jira / Slack keys. Never here.
 *
 * Note what is deliberately absent: no Jira, Slack or PagerDuty keys. Those
 * live in Zone 3 behind the Proxy Action Layer. If one ever appears in this
 * file, the blast radius of a Next.js compromise changes category.
 */

/** Thrown when a required credential is missing, with a fix-it message. */
export class MissingEnvError extends Error {
  constructor(name: string) {
    super(
      `Missing required environment variable: ${name}\n` +
        `Add it to frontend/.env.local — see .env.local.example.`,
    );
    this.name = "MissingEnvError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new MissingEnvError(name);
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Read lazily rather than at module load.
 *
 * A top-level `const APP_ID = required(...)` would crash the entire dev server
 * on import if the file is missing — including the dashboard, which does not
 * need credentials to render. Failing per-request keeps the console usable in
 * replay mode while the API routes report a precise, actionable error.
 */
export const serverEnv = {
  get agoraAppId(): string {
    return required("AGORA_APP_ID");
  },
  get agoraAppCertificate(): string {
    return required("AGORA_APP_CERTIFICATE");
  },
  /** Customer ID/secret for the Conversational AI REST API (Basic auth). */
  get agoraCustomerId(): string {
    return required("AGORA_CUSTOMER_ID");
  },
  get agoraCustomerSecret(): string {
    return required("AGORA_CUSTOMER_SECRET");
  },
  /**
   * Fast Loop LLM key.
   *
   * Groq rather than OpenAI: no OpenAI key was available, and Groq's API is
   * OpenAI-chat-completions compatible with SSE, which is exactly what Agora's
   * custom-LLM integration requires. Verified against the live Agora API —
   * see `session_log.md`, "Groq instead of OpenAI".
   *
   * This lives in Zone 2 for the same reason the OpenAI key did: Agora needs it
   * inside the create-agent payload, so Next.js has to hold it. It is NOT a
   * Zone 3 key — it cannot change the world, only generate text.
   */
  get groqApiKey(): string {
    return required("GROQ_API_KEY");
  },
  /**
   * Which TTS vendor to configure. Groq has no TTS and is not on Agora's
   * vendor list, so Echo's voice must come from somewhere else.
   */
  get ttsVendor(): "elevenlabs" | "sarvam" {
    const v = optional("TTS_VENDOR", "elevenlabs").toLowerCase();
    if (v !== "elevenlabs" && v !== "sarvam") {
      throw new MissingEnvError(
        `TTS_VENDOR must be "elevenlabs" or "sarvam", got "${v}"`,
      );
    }
    return v;
  },
  /** The TTS key for whichever vendor is selected. */
  get ttsApiKey(): string {
    return required(
      this.ttsVendor === "elevenlabs" ? "ELEVENLABS_API_KEY" : "SARVAM_API_KEY",
    );
  },
  /** ElevenLabs voice id. Defaults to a neutral, clinical-sounding voice. */
  get elevenLabsVoiceId(): string {
    return optional("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB");
  },
  /**
   * Sarvam speaker name. Must be compatible with the pinned model
   * (`bulbul:v3` — see `buildTtsConfig`). v2 voices like `anushka` are
   * rejected by v3 outright.
   */
  get sarvamSpeaker(): string {
    return optional("SARVAM_SPEAKER", "anand");
  },
  get sarvamLanguage(): string {
    return optional("SARVAM_LANGUAGE", "en-IN");
  },
  /** Base URL of the Python Roster Service. Falls back to the in-process one. */
  get rosterServiceUrl(): string | null {
    const v = process.env.ROSTER_SERVICE_URL?.trim();
    return v && v !== "" ? v : null;
  },
  /** Shared secret Agora signs webhook deliveries with (§W7). */
  get agentEventsSecret(): string | null {
    const v = process.env.AGORA_WEBHOOK_SECRET?.trim();
    return v && v !== "" ? v : null;
  },
  get agoraApiBase(): string {
    return optional("AGORA_API_BASE", "https://api.agora.io");
  },

  /**
   * PUBLIC base URL of the Slow Loop, for Agora's REST tools.
   *
   * ── WHY THIS CANNOT DEFAULT TO LOCALHOST ────────────────────────────────
   * Agora's Conversational AI Engine calls tool endpoints from ITS OWN
   * servers, not from the browser. `http://127.0.0.1:8000` resolves to
   * Agora's machine, not ours, so a tool pointed at localhost fails on their
   * side with nothing visible here.
   *
   * Null when unset, and the agent is then created WITHOUT tools rather than
   * with tools that cannot work. A tool that always fails is worse than no
   * tool: the model keeps trying it, gets errors, and eventually answers from
   * its own memory — which is the hallucination this product exists to stop.
   *
   * For a local demo, expose the Slow Loop with a tunnel and set this:
   *     ngrok http 8000   →   AGENT_TOOL_BASE_URL=https://<id>.ngrok-free.app
   */
  get agentToolBaseUrl(): string | null {
    const v = process.env.AGENT_TOOL_BASE_URL?.trim().replace(/\/+$/, "");
    return v && v !== "" ? v : null;
  },

  /**
   * Shared secret sent with every tool call, as `X-Echo-Tool-Token`.
   *
   * A tunnel does not expose one endpoint — it exposes the whole Slow Loop,
   * `/incident/reset` and `/bridge/say` included. The backend refuses any
   * non-local request without this header, so without the secret the tools
   * would 401 and Echo would be unable to read the Ledger.
   *
   * Null when unset. `start.ps1 -Tunnel` generates one and writes both halves.
   */
  /**
   * Which Fast Loop to build: "managed" (Agora supplies the model, exactly as
   * the official quickstart does) or "groq" (our pinned model and key).
   *
   * Defaults to managed, because that is the path the brief asks to
   * demonstrate and the only one whose LLM turn is known to complete here.
   */
  get llmMode(): "managed" | "groq" {
    return process.env.AGENT_LLM_MODE?.trim() === "groq" ? "groq" : "managed";
  },

  get agentToolSecret(): string | null {
    const v = process.env.AGENT_TOOL_SECRET?.trim();
    return v && v !== "" ? v : null;
  },

  get redisUrl(): string {
    return optional("REDIS_URL", "redis://127.0.0.1:6379/0");
  },

  get qdrantUrl(): string {
    return optional("QDRANT_URL", "http://127.0.0.1:6333");
  },
};

// `JWT_VERIFY_SECRET` and `AUTH_GATEWAY_SECRET` (used by `getSessionUser` in
// `auth.ts` to decide whether a Bearer JWT or an `x-user-profile` header can
// be trusted) are read directly from `process.env` in that file instead of
// through `serverEnv` here — this module imports `server-only`, which throws
// when loaded outside a real Next.js bundler, and `auth.ts` is exercised
// directly by the plain Node test runner.

/**
 * Report which credentials are present WITHOUT reading their values.
 *
 * Used by the health endpoint and the S0 spike so an operator can see what is
 * configured before a live run. Returns booleans only — never the secrets —
 * so the result is safe to render or log.
 */
export function credentialStatus(): Record<string, boolean> {
  const present = (n: string) => Boolean(process.env[n]?.trim());

  // Only the SELECTED vendor's key is required, so reporting both would show a
  // permanent false for the one you deliberately are not using — which trains
  // people to ignore this endpoint.
  const vendor = (process.env.TTS_VENDOR?.trim() || "elevenlabs").toLowerCase();
  const ttsKeyName =
    vendor === "sarvam" ? "SARVAM_API_KEY" : "ELEVENLABS_API_KEY";

  return {
    AGORA_APP_ID: present("AGORA_APP_ID"),
    AGORA_APP_CERTIFICATE: present("AGORA_APP_CERTIFICATE"),
    AGORA_CUSTOMER_ID: present("AGORA_CUSTOMER_ID"),
    AGORA_CUSTOMER_SECRET: present("AGORA_CUSTOMER_SECRET"),
    GROQ_API_KEY: present("GROQ_API_KEY"),
    [ttsKeyName]: present(ttsKeyName),
  };
}
