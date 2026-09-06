import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  ASR_LABEL,
  GROQ_LLM_LABEL,
  llmLabel,
  MANAGED_LLM_LABEL,
  TTS_LABEL,
  VAD_INTERRUPT_MS,
  VAD_SILENCE_MS,
} from "../src/lib/pipeline-facts.ts";

/**
 * The status bar claims to tell an operator which system they are talking to.
 * It was lying on three of four rows — `groq/gpt-oss-120b` and `agora` while
 * the pipeline actually ran Agora-managed gpt-4o-mini and Deepgram nova-3 —
 * because the strings were hardcoded in the component and nothing tied them to
 * the pipeline they described.
 *
 * These tests tie them to it: they read `backend/app/voice_agent.py`, the file
 * that really builds the pipeline, and fail if a vendor changes there without
 * the label changing here. A comment saying "keep in sync" does not survive a
 * deadline; a failing test does.
 */
const VOICE_AGENT = readFileSync(
  new URL("../../backend/app/voice_agent.py", import.meta.url),
  "utf8",
);

describe("status bar labels match the pipeline the backend builds", () => {
  test("ASR names the model the SDK is actually given", () => {
    assert.match(
      VOICE_AGENT,
      /DeepgramSTT\(model="nova-3"/,
      "voice_agent.py no longer builds Deepgram nova-3",
    );
    assert.equal(ASR_LABEL, "deepgram/nova-3");
  });

  test("VAD timings match the SDK turn_detection block", () => {
    const interrupt = VOICE_AGENT.match(/"interrupt_duration_ms":\s*(\d+)/);
    const silence = VOICE_AGENT.match(/"silence_duration_ms":\s*(\d+)/);
    assert.ok(interrupt && silence, "turn_detection timings not found");
    assert.equal(VAD_INTERRUPT_MS, Number(interrupt[1]));
    assert.equal(VAD_SILENCE_MS, Number(silence[1]));
  });

  test("TTS names the model id the SDK sends", () => {
    assert.match(
      VOICE_AGENT,
      /MiniMaxTTS\(\s*model="speech_2_6_turbo"/,
      "voice_agent.py no longer builds Agora-managed MiniMax",
    );
    assert.equal(TTS_LABEL, "minimax/speech-2.6");
  });

  test("the managed LLM label names the managed model", () => {
    assert.match(
      VOICE_AGENT,
      /OpenAI\(\s*model="gpt-4o-mini"/,
      "the managed branch no longer pins gpt-4o-mini",
    );
    assert.match(MANAGED_LLM_LABEL, /gpt-4o-mini/);
    // Managed is the default, so a bare call must not claim Groq — the exact
    // wrong answer the hardcoded label used to give.
    assert.equal(llmLabel(), MANAGED_LLM_LABEL);
    assert.equal(llmLabel("groq"), GROQ_LLM_LABEL);
  });
});
