"use client";

import { useIncident } from "@/lib/incident-store";
import { clock } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Dot, Rule } from "@/components/ui/Signal";
import { Kbd } from "@/components/ui/Button";
import { analysisLabel, ASR_LABEL, llmLabel, TTS_LABEL, VAD_LABEL } from "@/lib/pipeline-facts";

/**
 * The foot of the console.
 *
 * Borrowed wholesale from IDEs and terminals, and for the same reason: it is
 * where an operator looks to confirm *which* system they are talking to when
 * something looks wrong. Pipeline vendors, model ids and the local clock live
 * here permanently so nobody has to open a settings panel mid-incident to find
 * out whether they are on the right STT provider.
 *
 * 24px, one type size, no colour except a single transport dot.
 */

function Item({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" title={title}>
      <span className="text-[10px] tracking-[0.06em] text-ink-4 uppercase">
        {label}
      </span>
      <span className="tnum font-mono text-[10px] text-ink-3">{value}</span>
    </span>
  );
}

export function StatusBar() {
  const { state, now, source } = useIncident();

  return (
    <footer className="scroll-thin z-20 flex h-6 shrink-0 items-center gap-3 overflow-x-auto border-t border-line bg-raised px-3">
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        <Dot
          tone={state.bridge === "live" ? "stable" : "neutral"}
          pulse={state.bridge === "live"}
        />
        <span className="text-[10px] tracking-[0.06em] text-ink-3 uppercase">
          {state.bridge === "live" ? "Bridge live" : "Bridge idle"}
        </span>
      </span>

      {/*
        Which source is driving the console.

        REHEARSAL is called out in warning amber because a scripted replay that
        reads as a live incident is a lie the operator cannot detect. The whole
        product is about not letting an assumption pass as a fact; the console
        does not get to exempt itself from that.
      */}
      {source ? (
        <span
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
          title={
            source === "live"
              ? "Receiving sequenced deltas from the Slow Loop"
              : "Scripted replay — no Slow Loop connection. Nothing on screen is live."
          }
        >
          <span
            className={cn(
              "rounded-[2px] border px-1 text-[9px] font-semibold tracking-[0.08em] uppercase",
              source === "live"
                ? "border-stable/35 bg-stable/10 text-stable"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {source === "live" ? "Live data" : "Rehearsal"}
          </span>
        </span>
      ) : null}

      <Rule className="h-3 shrink-0" />

      {/*
        These must stay TRUE. This strip is where an operator looks to confirm
        which system they are actually talking to when something looks wrong, so
        a stale vendor name here is worse than no name at all — it sends whoever
        is debugging to the wrong provider's dashboard.

        They were hardcoded here, which is exactly how all four went stale: they
        read `groq/gpt-oss-120b` and `agora` while the pipeline was actually on
        Agora-managed gpt-4o-mini and Deepgram nova-3. Nothing connected the
        label to the thing it described. They now come from `pipeline-facts.ts`,
        which mirrors `backend/app/voice_agent.py` — the file that really builds
        the pipeline.
      */}
      <Item label="LLM" value={llmLabel()} title="Fast Loop brain — what Echo SPEAKS with. Agora-managed and cascaded, not audio-to-audio." />
      {/*
        The Slow Loop's model, which was invisible here. Two LLMs run in this
        product and only one was on the bar, so a Gemma-configured analysis
        pipeline looked like it was not running at all.
      */}
      <Item label="ANALYSIS" value={analysisLabel()} title="Slow Loop brain — extraction, contradiction adjudication and the Deliberation Panel. Separate from the voice model." />
      <Item label="VAD" value={VAD_LABEL} title="Turn detection — barge-in / end-of-speech thresholds in ms" />
      <Item label="ASR" value={ASR_LABEL} title="Speech-to-text — Agora-managed Deepgram nova-3, no vendor key required" />
      <Item label="TTS" value={TTS_LABEL} title="Echo's voice — low-latency model, chosen because the cascade already costs us the §12.1 budget" />

      <Rule className="h-3 shrink-0" />

      <Item
        label="Frames"
        value={state.transcripts.length.toString().padStart(3, "0")}
        title="RTM transcript frames retained after deduplication"
      />
      <Item
        label="Claims"
        value={state.claims.length.toString().padStart(2, "0")}
        title="Rows in the Evidence Ledger"
      />
      <Item
        label="Entities"
        value={state.entities.length.toString().padStart(2, "0")}
        title="Nodes on the root-cause graph"
      />

      {/* Keyboard affordances sit at the right, out of the reading path but
          always visible — discoverable without being loud. */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <span className="hidden items-center gap-1.5 lg:flex">
          <Kbd>J</Kbd>
          <span className="text-[10px] text-ink-4">bridge</span>
        </span>
        <span className="hidden items-center gap-1.5 lg:flex">
          <Kbd>M</Kbd>
          <span className="text-[10px] text-ink-4">mute</span>
        </span>
        <Rule className="h-3 shrink-0" />
        <span
          className="tnum font-mono text-[10px] whitespace-nowrap text-ink-3"
          suppressHydrationWarning
        >
          {now ? clock(now) : "--:--:--"}
        </span>
      </div>
    </footer>
  );
}
