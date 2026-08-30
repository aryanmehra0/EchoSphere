"use client";

import { cn } from "@/lib/cn";
import { useIncident } from "@/lib/incident-store";
import { useVoiceEnvelope } from "@/hooks/useVoiceEnvelope";
import { Dot } from "@/components/ui/Signal";
import type { AgentState } from "@/lib/types";

/**
 * Echo's presence card.
 *
 * The hardest UX problem in a voice-agent product is that the agent is
 * invisible: a human on the bridge cannot tell whether it is listening,
 * deliberating, about to speak, or simply dead. That ambiguity is what makes
 * people talk over agents and then stop trusting them.
 *
 * So agent state is given three redundant encodings — a colour, a word, and a
 * distinct waveform behaviour — and it is the largest single element in the
 * left column. It is also wired to an `aria-live` region, because a
 * screen-reader user gets no benefit at all from a waveform.
 */

const AGENT_COPY: Record<
  AgentState,
  { label: string; tone: "neutral" | "live" | "warning" | "stable"; note: string }
> = {
  offline: {
    label: "Offline",
    tone: "neutral",
    note: "Not attached to the bridge",
  },
  joining: {
    label: "Joining",
    tone: "live",
    note: "Negotiating with SD-RTN",
  },
  listening: {
    label: "Listening",
    tone: "stable",
    note: "Silent by default — speaks only on trigger",
  },
  thinking: {
    label: "Analysing",
    tone: "warning",
    note: "Cross-checking claims against the ledger",
  },
  speaking: {
    label: "Speaking",
    tone: "live",
    note: "Holding the floor",
  },
};

const BARS = 9;

export function AgentPresence() {
  const { state, agentTrack } = useIncident();
  const agent = state.agent;
  const copy = AGENT_COPY[agent];

  const speaking = agent === "speaking";
  const { registerBar } = useVoiceEnvelope({
    track: agentTrack?.getMediaStreamTrack() ?? null,
    active: speaking,
    bars: BARS,
  });

  return (
    <div
      className={cn(
        "surface relative overflow-hidden rounded-md px-3 py-3",
        "transition-colors duration-300 ease-[var(--ease-out)]",
        speaking && "border-live/35",
      )}
    >
      {/* A single soft wash behind the card while Echo holds the floor. This
          is the one place a glow is permitted, because "the AI is talking" is
          precisely the state that must be legible from across the room. */}
      {speaking ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-px bg-[radial-gradient(120%_100%_at_50%_0%,var(--color-live)/10%,transparent_70%)]"
        />
      ) : null}

      <div className="relative flex items-center gap-3">
        {/* Identity mark */}
        <div
          className={cn(
            "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border transition-colors duration-300",
            speaking
              ? "border-live/50 bg-live/12"
              : agent === "offline"
                ? "border-line bg-sunken"
                : "border-line-strong bg-overlay",
          )}
          aria-hidden
        >
          <span
            className={cn(
              "font-mono text-sm font-semibold transition-colors duration-300",
              speaking ? "text-live" : agent === "offline" ? "text-ink-4" : "text-ink-2",
            )}
          >
            E
          </span>
        </div>

        {/* State */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Dot tone={copy.tone} pulse={agent === "listening" || speaking} />
            <span className="text-xs font-semibold tracking-tight text-ink">
              {copy.label}
            </span>
          </div>
          <p className="truncate text-2xs text-ink-4">{copy.note}</p>
        </div>

        {/* Waveform. Heights are written imperatively by useVoiceEnvelope. */}
        <div
          className="flex h-7 items-center gap-[3px]"
          aria-hidden
          title={speaking ? "Agent audio level" : "Agent idle"}
        >
          {Array.from({ length: BARS }, (_, i) => (
            <span
              key={i}
              ref={registerBar(i)}
              style={{ height: "3px" }}
              className={cn(
                "w-[2px] rounded-full transition-colors duration-300",
                speaking ? "bg-live" : "bg-ink-4",
              )}
            />
          ))}
        </div>
      </div>

      {/* Non-visual announcement of agent state. Polite so it never interrupts
          the operator's own screen-reader flow mid-sentence. */}
      <span className="sr-only" role="status" aria-live="polite">
        Echo is {copy.label.toLowerCase()}.
      </span>
    </div>
  );
}
