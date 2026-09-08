/**
 * What the voice pipeline is ACTUALLY made of, in one place.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The status bar's own comment says these values "must stay TRUE", because it
 * is where an operator looks to confirm which system they are talking to when
 * something looks wrong. All four of them had drifted anyway:
 *
 *   shown              actually in the request path
 *   ─────────────────  ─────────────────────────────────────────────
 *   LLM groq/oss-120b  gpt-4o-mini, Agora-managed (AGENT_LLM_MODE=managed)
 *   ASR agora          Deepgram nova-3, Agora-managed
 *   VAD agora_vad      mode "default", nested start/end_of_speech config
 *   TTS flash-v2.5     correct, but the voice id was empty and fell back
 *
 * A stale vendor name here is worse than no name at all: it sends whoever is
 * debugging to the wrong provider's dashboard. The strings were hardcoded in
 * the component, so nothing connected them to the pipeline they described and
 * every config change silently made them wronger.
 *
 * The pipeline is now built by the SDK in `backend/app/voice_agent.py`, so
 * these constants mirror that file. They are deliberately NOT re-derived from
 * `agent-config.ts` — that module no longer decides the vendors, and importing
 * a stale authority is how this drift started.
 *
 * KEEP IN SYNC WITH `backend/app/voice_agent.py`. If you change a vendor there,
 * change it here; `tests/pipeline-facts.test.ts` asserts the pairs that can be
 * checked from this side.
 */

/** Agora-managed Deepgram. No Deepgram key is required or sent. */
export const ASR_LABEL = "deepgram/nova-3";

/**
 * Barge-in and end-of-speech, matching `voice_agent.py`'s turn_detection.
 * The quickstart's values, adopted deliberately when the SDK path was built so
 * that only one variable changed at a time.
 */
/*
  KEEP IN SYNC WITH `backend/app/adapters/agora_agent.py` — see the header
  note. That file builds the agent, so it owns these numbers; this mirror is
  display only, and `tests/pipeline-facts.test.ts` checks what it can.
*/
export const VAD_INTERRUPT_MS = 640;
export const VAD_SILENCE_MS = 1500;

/*
  BOTH numbers are shown now. End-of-speech is the one that decides whether a
  whole sentence survives, and it was invisible here while a 480ms value
  truncated every utterance — an operator staring at this bar had no way to
  see the setting that was breaking their transcript.
*/
export const VAD_LABEL = `vad · ${VAD_INTERRUPT_MS}/${VAD_SILENCE_MS}ms`;

/**
 * Echo's voice — Agora-managed MiniMax, the quickstart's own vendor.
 *
 * BYOK ElevenLabs was dropped here: no TTS credential of ours is in the
 * request path any more, which removed an empty ELEVENLABS_VOICE_ID and a key
 * so permission-scoped it could not list its own voices.
 */
export const TTS_LABEL = "minimax/speech-2.6";

/**
 * The Fast Loop brain, per AGENT_LLM_MODE.
 *
 * "managed" means Agora supplies and bills the model, so no key of ours is in
 * the request path; that is the default and what the console is running.
 */
export const MANAGED_LLM_LABEL = "gpt-4o-mini (agora)";
export const GROQ_LLM_LABEL = "groq/gpt-oss-120b";

/**
 * The SLOW Loop's analysis model — extraction, contradictions, the panel.
 *
 * ── WHY THIS ROW EXISTS ─────────────────────────────────────────────────────
 * The status bar showed only Fast Loop components (LLM / VAD / ASR / TTS), so
 * there was NO WAY to tell which model was doing the analysis. That produced
 * exactly the confusion it should have prevented: with `ANALYSIS_PROVIDER=gemma`
 * configured and Gemma demonstrably running the Deliberation Panel — the
 * persisted verdict names `gemma4` on both personas — the bar still read
 * `gpt-4o-mini`, and the reasonable conclusion was that Gemma was not wired up.
 *
 * Both were true at once. `gpt-4o-mini` IS Echo's voice; Gemma IS the analysis.
 * The bar was not wrong, it was incomplete, and an incomplete status bar on a
 * product whose whole claim is an accurate record is its own small betrayal.
 *
 * Mirrors `ANALYSIS_PROVIDER` / `GEMMA_MODEL` in `.env.local`, the same way the
 * rows above mirror the backend's turn detection. `NEXT_PUBLIC_` prefixed
 * because the browser needs it and it names a model, never a key.
 */
export function analysisLabel(): string {
  const provider = (process.env.NEXT_PUBLIC_ANALYSIS_PROVIDER ?? "groq")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (provider === "gemma") {
    return process.env.NEXT_PUBLIC_GEMMA_MODEL?.trim() || "gemma4 (local)";
  }
  return "groq/gpt-oss-120b";
}

export function llmLabel(mode: "managed" | "groq" = "managed"): string {
  return mode === "groq" ? GROQ_LLM_LABEL : MANAGED_LLM_LABEL;
}
