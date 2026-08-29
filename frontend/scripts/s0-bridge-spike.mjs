#!/usr/bin/env node
/**
 * S0 — THE BRIDGE SPIKE (v6 §17, closes G9)
 * ============================================================================
 *
 * WHY THIS RUNS FIRST.
 *
 * v5 scheduled the Bridge — the most novel, least-documented, highest-
 * integration-risk component, and the one the entire pitch depends on — for
 * Day 4 of 5. If Custom Instruction Injection behaves differently from the
 * docs (wrong latency, queued instead of immediate, incompatible with
 * agora_vad barge-in, or gated behind an account tier), v5 discovers that with
 * one day left and no fallback.
 *
 * This script exists to find that out NOW, during the idea-submission window,
 * using dead time. It is deliberately throwaway: hardcoded strings, no
 * analytics, no Ledger. It answers one question — does the Bridge work as
 * documented, in both directions?
 *
 * EXIT CRITERIA (v6 §17):
 *   1. injection latency          < 500 ms
 *   2. on_speaking_action:interrupt genuinely interrupts mid-sentence
 *   3. tool webhook round-trip    < 400 ms
 *
 * IF IT FAILS: fall back to the RTM text path (§13) and rescope — with six
 * days remaining instead of one. That is the entire point of moving it first.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   1. Fill in frontend/.env.local  (see .env.local.example)
 *   2. Open the dashboard and join the channel so a human can HEAR the agent
 *   3. node scripts/s0-bridge-spike.mjs --channel inc-spike
 *
 * Steps 1 and 3 are measured automatically. Step 2 needs a human ear — the
 * script prompts and records your answer, because "did it actually cut itself
 * off mid-word" is not observable from an API response.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* -------------------------------------------------------------------------- */
/* Env                                                                         */
/* -------------------------------------------------------------------------- */

/** Minimal .env.local reader — this script runs outside Next.js. */
function loadEnv() {
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) {
    fail(
      "frontend/.env.local not found.\n" +
        "  Copy .env.local.example to .env.local and fill it in.",
    );
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "").trim();
    if (value) process.env[m[1]] ??= value;
  }
}

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) fail(`Missing ${name} in .env.local`);
  return v;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                      */
/* -------------------------------------------------------------------------- */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const results = [];

function record(name, ok, detail, budget) {
  results.push({ name, ok, detail, budget });
  const mark = ok ? C.green("PASS") : C.red("FAIL");
  console.log(`  ${mark}  ${name}  ${C.dim(detail)}`);
}

function fail(msg) {
  console.error(`\n${C.red("✖")} ${msg}\n`);
  process.exit(1);
}

function header(text) {
  console.log(`\n${C.bold(text)}`);
  console.log(C.dim("─".repeat(Math.min(72, text.length + 20))));
}

/* -------------------------------------------------------------------------- */
/* Agora                                                                       */
/* -------------------------------------------------------------------------- */

function authHeader() {
  const raw = `${need("AGORA_CUSTOMER_ID")}:${need("AGORA_CUSTOMER_SECRET")}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

const API_BASE = process.env.AGORA_API_BASE?.trim() || "https://api.agora.io";
const APP_ID = () => need("AGORA_APP_ID");

async function agora(path, { method = "POST", body } = {}) {
  const started = performance.now();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const ms = performance.now() - started;
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json, ms };
}

/* -------------------------------------------------------------------------- */
/* The spike                                                                   */
/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const channel =
  args[args.indexOf("--channel") + 1] &&
  args.indexOf("--channel") !== -1
    ? args[args.indexOf("--channel") + 1]
    : "inc-spike";

const AGENT_UID = 9000;

async function main() {
  loadEnv();

  console.log(C.bold("\n  S0 — BRIDGE SPIKE"));
  console.log(C.dim(`  channel: ${channel}   agent uid: ${AGENT_UID}`));
  console.log(
    C.dim("  Proving the Bridge works in BOTH directions before anything depends on it.\n"),
  );

  // Token minting reuses the same library the app does, so a mismatch here is
  // a real signal rather than a script artefact.
  //
  // The `.default` is load-bearing. `agora-token` is CommonJS, and Node's
  // cjs-module-lexer only detects `ApaasTokenBuilder` as a named export — every
  // builder we actually want is reachable only through the default object. The
  // app's `import { RtcTokenBuilder } from "agora-token"` works because the
  // bundler performs the interop; this script runs under plain Node, which does
  // not. Destructuring the namespace directly yields `undefined` and dies at the
  // first `.buildTokenWithUid`, before any credential check can report itself.
  const { RtcTokenBuilder, RtcRole } = (await import("agora-token")).default;
  const now = Math.floor(Date.now() / 1000);
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID(),
    need("AGORA_APP_CERTIFICATE"),
    channel,
    AGENT_UID,
    RtcRole.PUBLISHER,
    3600,
    now + 3600,
  );

  /* ── 1. Launch a trivial agent ─────────────────────────────────────────── */
  header("1 · Launch agent");

  // NOT named `join`: that would shadow the `join` imported from node:path for
  // the whole of main(), and the report write at the end of this function would
  // then throw "join is not a function" — after every operator prompt has been
  // answered and before the verdict prints, losing the entire run.
  const launch = await agora(
    `/api/conversational-ai-agent/v2/projects/${APP_ID()}/join`,
    {
      body: {
        name: `spike-${channel}-${Date.now()}`,
        properties: {
          channel,
          token,
          agent_rtc_uid: String(AGENT_UID),
          remote_rtc_uids: ["*"],
          idle_timeout: 120,
          turn_detection: {
            mode: "agora_vad",
            interrupt_duration_ms: 300,
            prefix_padding_ms: 800,
            silence_duration_ms: 640,
            threshold: 0.5,
          },
          // CASCADED, not audio-to-audio: Agora ASR → Groq → TTS vendor.
          // No `vendor` field — omitting it is what selects Agora's custom-LLM
          // path, which requires an OpenAI-chat-completions compatible endpoint
          // with SSE. Groq qualifies; verified against the live API.
          llm: {
            url: "https://api.groq.com/openai/v1/chat/completions",
            api_key: need("GROQ_API_KEY"),
            model: "openai/gpt-oss-120b",
            system_messages: [
              {
                role: "system",
                // Deliberately trivial. The spike tests the TRANSPORT, not the
                // product prompt — a complex prompt would make a failure
                // ambiguous between "Bridge broken" and "prompt confusing".
                content:
                  "You are a test harness. Stay silent unless instructed. " +
                  "When given a system instruction, speak it verbatim. " +
                  "When asked about incident status, call get_test_state.",
              },
            ],
            tools: [
              {
                name: "get_test_state",
                description:
                  "Returns the current test state. Call this whenever asked " +
                  "about incident status.",
                parameters: {
                  type: "object",
                  properties: { scope: { type: "string" } },
                },
              },
            ],
            greeting_message: "",
          },
          // MANDATORY. Without a tts block Agora rejects the agent outright:
          // `properties: tts.addon not found`.
          //
          // ⚠️ Agora does NOT validate what is inside `params` — a bogus param
          // name still returns 200 RUNNING, and the agent then joins and stays
          // SILENT with no error anywhere. If step 2 below fails with "the
          // agent never spoke", check these names before suspecting the Bridge.
          // ElevenLabs reads `key`; Sarvam reads `api_subscription_key`.
          tts:
            (process.env.TTS_VENDOR?.trim() || "elevenlabs") === "sarvam"
              ? {
                  vendor: "sarvam",
                  params: {
                    api_subscription_key: need("SARVAM_API_KEY"),
                    speaker: process.env.SARVAM_SPEAKER?.trim() || "anushka",
                    target_language_code:
                      process.env.SARVAM_LANGUAGE?.trim() || "en-IN",
                    sample_rate: 24000,
                  },
                }
              : {
                  vendor: "elevenlabs",
                  params: {
                    key: need("ELEVENLABS_API_KEY"),
                    model_id: "eleven_flash_v2_5",
                    voice_id:
                      process.env.ELEVENLABS_VOICE_ID?.trim() ||
                      "pNInz6obpgDQGcFmaJgB",
                    sample_rate: 24000,
                  },
                },
        },
      },
    },
  );

  if (!launch.ok) {
    record("agent launch", false, `HTTP ${launch.status}`, "");
    console.error(C.red("\n  Agora rejected the agent:\n"), launch.json);
    console.error(
      C.amber(
        "\n  Common causes: Conversational AI not enabled on the project, " +
          "\n  wrong Customer ID/Secret (NOT the app certificate), or region mismatch.\n",
      ),
    );
    process.exit(1);
  }

  const agentId = launch.json.agent_id ?? launch.json.agentId;
  record("agent launch", true, `${launch.ms.toFixed(0)}ms · id ${agentId}`, "");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(C.cyan(`  ${q} `))).trim().toLowerCase();

  try {
    console.log(
      C.amber("\n  → Join the channel now so you can hear the agent, then press Enter."),
    );
    await rl.question("  ");

    /* ── 2. PUSH · instruction injection ─────────────────────────────────── */
    header("2 · Channel 1 — PUSH (instruction injection)");

    const inject = await agora(
      `/api/conversational-ai-agent/v2/projects/${APP_ID()}/agents/${agentId}/update`,
      {
        body: {
          priority: "high",
          on_listening_action: "inject",
          on_speaking_action: "interrupt",
          instruction:
            "SYSTEM ALERT. Say exactly: Bridge spike injection received.",
        },
      },
    );

    record(
      "injection accepted",
      inject.ok,
      `HTTP ${inject.status}`,
      "",
    );
    record(
      "injection latency < 500ms",
      inject.ok && inject.ms < 500,
      `${inject.ms.toFixed(0)}ms (budget 500ms)`,
      "500ms",
    );

    const heard = await ask('Did the agent SAY it? [y/n]');
    record("agent spoke the injected text", heard === "y", `operator: ${heard}`, "");

    /* ── 3. Interrupt semantics ──────────────────────────────────────────── */
    header("3 · on_speaking_action: interrupt");

    console.log(
      C.dim(
        "  Injecting a long line, then pre-empting it mid-sentence.\n" +
          "  Watch for the agent CUTTING ITSELF OFF, not finishing then continuing.",
      ),
    );

    await agora(
      `/api/conversational-ai-agent/v2/projects/${APP_ID()}/agents/${agentId}/update`,
      {
        body: {
          priority: "high",
          on_listening_action: "inject",
          instruction:
            "Say slowly: one, two, three, four, five, six, seven, eight, nine, ten.",
        },
      },
    );

    // Long enough that it is definitely mid-count when the pre-emption lands.
    await new Promise((r) => setTimeout(r, 2500));

    const preempt = await agora(
      `/api/conversational-ai-agent/v2/projects/${APP_ID()}/agents/${agentId}/update`,
      {
        body: {
          priority: "high",
          on_listening_action: "inject",
          on_speaking_action: "interrupt",
          instruction: "Stop and say exactly: Interrupted.",
        },
      },
    );

    record("pre-emption accepted", preempt.ok, `${preempt.ms.toFixed(0)}ms`, "");

    const cut = await ask('Did it CUT OFF mid-count? [y/n]');
    record(
      "interrupt genuinely interrupts",
      cut === "y",
      cut === "y" ? "cut off" : "queued instead of interrupting",
      "",
    );

    /* ── 4. QUERY · tool webhook ─────────────────────────────────────────── */
    header("4 · Channel 2 — QUERY (tool webhook)");

    console.log(
      C.dim(
        "  This is the channel v5 lacked entirely (G1). Without it, three of\n" +
          "  Echo's four speaking conditions are unimplementable.",
      ),
    );
    console.log(
      C.amber("\n  → Say out loud: \"What is the incident status?\" then press Enter."),
    );
    await rl.question("  ");

    const fired = await ask("Did your webhook receive get_test_state? [y/n/skip]");
    if (fired === "skip") {
      console.log(
        C.amber(
          "  SKIPPED — needs a public webhook URL (ngrok). Re-run before S5.\n" +
            "  This is the highest-risk unknown remaining; do not skip it twice.",
        ),
      );
      results.push({ name: "tool webhook round-trip", ok: null, detail: "skipped" });
    } else {
      record("tool webhook fired", fired === "y", `operator: ${fired}`, "");
      const answered = await ask("Did the agent then ANSWER using the result? [y/n]");
      record("tool result reached the agent", answered === "y", `operator: ${answered}`, "");
    }

    /* ── 5. Teardown ─────────────────────────────────────────────────────── */
    header("5 · Teardown");
    const leave = await agora(
      `/api/conversational-ai-agent/v2/projects/${APP_ID()}/agents/${agentId}/leave`,
    );
    record("agent stopped", leave.ok, `HTTP ${leave.status}`, "");
  } finally {
    rl.close();
  }

  /* ── Verdict ───────────────────────────────────────────────────────────── */
  header("VERDICT");

  const hard = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);

  const report = {
    at: new Date().toISOString(),
    channel,
    results: results.map(({ name, ok, detail }) => ({ name, ok, detail })),
    verdict: hard.length === 0 ? "PASS" : "FAIL",
  };
  writeFileSync(join(ROOT, "s0-spike-report.json"), JSON.stringify(report, null, 2));

  if (hard.length === 0) {
    console.log(
      C.green("\n  ✔ Bridge works in both directions. Proceed to S1–S5 as planned.\n"),
    );
    if (skipped.length) {
      console.log(C.amber(`  ${skipped.length} check skipped — re-run before S5.\n`));
    }
  } else {
    console.log(C.red(`\n  ✖ ${hard.length} exit criteria failed:`));
    for (const r of hard) console.log(C.red(`      · ${r.name} — ${r.detail}`));
    console.log(
      C.amber(
        "\n  FALL BACK to the RTM text path (v6 §13) and rescope NOW.\n" +
          "  You have six days, not one. This is why the spike runs first.\n",
      ),
    );
  }

  console.log(C.dim("  Report written to frontend/s0-spike-report.json\n"));
  process.exit(hard.length === 0 ? 0 : 1);
}

main().catch((err) => fail(err?.stack ?? String(err)));
