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
  get openAiApiKey(): string {
    return required("OPENAI_API_KEY");
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
};

/**
 * Report which credentials are present WITHOUT reading their values.
 *
 * Used by the health endpoint and the S0 spike so an operator can see what is
 * configured before a live run. Returns booleans only — never the secrets —
 * so the result is safe to render or log.
 */
export function credentialStatus(): Record<string, boolean> {
  const present = (n: string) => Boolean(process.env[n]?.trim());
  return {
    AGORA_APP_ID: present("AGORA_APP_ID"),
    AGORA_APP_CERTIFICATE: present("AGORA_APP_CERTIFICATE"),
    AGORA_CUSTOMER_ID: present("AGORA_CUSTOMER_ID"),
    AGORA_CUSTOMER_SECRET: present("AGORA_CUSTOMER_SECRET"),
    OPENAI_API_KEY: present("OPENAI_API_KEY"),
  };
}
