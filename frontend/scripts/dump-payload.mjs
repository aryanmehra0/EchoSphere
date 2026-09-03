/**
 * Print the exact create-agent payload we send to Agora, with dummy
 * credentials, so it can be diffed against the official quickstart.
 *
 *   node scripts/dump-payload.mjs          # tools disabled
 *   node scripts/dump-payload.mjs --tools  # tools enabled
 *
 * Exists because "are we following the quickstart?" is a question that should
 * be answered by looking at the bytes on the wire, not by reading intentions
 * out of the source.
 */
import { buildAgentPayload } from "../src/lib/server/agent-config.ts";

const withTools = process.argv.includes("--tools");

const payload = buildAgentPayload({
  channel: "inc-4417",
  agentUid: 9000,
  userUid: 1001,
  agentRtcToken: "<RTC_TOKEN>",
  groqApiKey: "<GROQ_KEY>",
  tts: { vendor: "elevenlabs", apiKey: "<TTS_KEY>", voiceId: "<VOICE_ID>" },
  ...(withTools
    ? { toolBaseUrl: "https://example.trycloudflare.com", toolSecret: "<TOOL_SECRET>" }
    : {}),
});

// The system prompt is 2kB and drowns the structure; the point here is shape.
const shown = JSON.parse(JSON.stringify(payload));
if (shown?.properties?.llm?.system_messages) {
  const n = shown.properties.llm.system_messages[0].content.length;
  shown.properties.llm.system_messages = [`<SYSTEM PROMPT, ${n} chars>`];
}
console.log(JSON.stringify(shown, null, 2));
