"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FlaskConical,
  HelpCircle,
  Loader2,
  Radio,
} from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { selectHypothesisMatrix } from "@/lib/incident-reducer";
import { triggerTelemetryProbe } from "@/lib/delta-socket";
import { clockShort, initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { HypothesisMatrixItem, HypothesisStatus } from "@/lib/types";

/**
 * Hypothesis Elimination Matrix Panel.
 *
 * Operationalizes epistemic discipline during Sev-1 outages:
 * 1. Collects spoken or scenario-loaded hypotheses (HYPOTHESIS claims).
 * 2. Cross-references each against telemetry probes (TOOL_RESULT) or human facts (OBSERVED).
 * 3. Classifies theory status into REFUTED, CORROBORATED, or OPEN.
 * 4. Enables 1-click active telemetry probing to test hypotheses live.
 *
 * Strictly adheres to Rule 1: Echo never asserts root cause.
 */

type Filter = "ALL" | HypothesisStatus;

export function TheoriesPanel() {
  const { state, dispatch } = useIncident();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [probingId, setProbingId] = useState<string | null>(null);

  const matrix = selectHypothesisMatrix(state);

  const counts = {
    ALL: matrix.length,
    OPEN: matrix.filter((m) => m.status === "OPEN").length,
    REFUTED: matrix.filter((m) => m.status === "REFUTED").length,
    CORROBORATED: matrix.filter((m) => m.status === "CORROBORATED").length,
  };

  const filtered = matrix.filter((item) => {
    if (filter === "ALL") return true;
    return item.status === filter;
  });

  const handleProbe = async (item: HypothesisMatrixItem) => {
    if (!item.suggestedProbe || probingId) return;
    setProbingId(item.hypothesis.id);

    try {
      const res = await triggerTelemetryProbe(
        item.suggestedProbe.entity,
        item.suggestedProbe.metric,
        item.hypothesis.entity,
      );

      if (res && res.claim) {
        dispatch({
          type: "DELTA",
          payload: {
            claims: [res.claim],
          },
        });
      }
    } catch {
      // Ignored: failure handled gracefully
    } finally {
      setProbingId(null);
    }
  };

  if (matrix.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical size={14} strokeWidth={2} />}
        title="No hypotheses recorded"
        hint="Engineering theories verbalized on the voice bridge will appear here and be cross-referenced against live telemetry."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-base">
      {/* ── Summary bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-line-faint bg-sunken/40 px-3 py-2 text-2xs">
        <div className="flex items-center gap-1.5">
          <FlaskConical size={12} className="text-ink-4" />
          <span className="font-semibold text-ink-2 uppercase tracking-wider text-[10px]">
            Elimination Matrix
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-ink-3">
          <span title="Theories ruled out by telemetry" className="text-stable">
            {counts.REFUTED} refuted
          </span>
          <span className="text-line">|</span>
          <span title="Symptoms confirmed by telemetry" className="text-warning">
            {counts.CORROBORATED} confirmed
          </span>
          <span className="text-line">|</span>
          <span title="Untested theories awaiting probe" className="text-ink-2">
            {counts.OPEN} open
          </span>
        </div>
      </div>

      {/* ── Filter pills ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-line-faint bg-base px-3 py-1.5 overflow-x-auto">
        {(["ALL", "OPEN", "REFUTED", "CORROBORATED"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-0.5 text-2xs font-medium cursor-pointer transition-colors",
              filter === f
                ? "bg-surface text-ink font-semibold shadow-xs border border-line-strong"
                : "text-ink-4 hover:text-ink-2 hover:bg-sunken/60",
            )}
          >
            <span>{f === "ALL" ? "All" : f === "OPEN" ? "Open" : f === "REFUTED" ? "Refuted" : "Corroborated"}</span>
            <span className="font-mono text-[9px] text-ink-4">({counts[f]})</span>
          </button>
        ))}
      </div>

      {/* ── Matrix Items List ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-line-faint">
        {filtered.map((item) => {
          const isRefuted = item.status === "REFUTED";
          const isCorroborated = item.status === "CORROBORATED";
          const isOpen = item.status === "OPEN";
          const isCurrentProbing = probingId === item.hypothesis.id;

          return (
            <div
              key={item.hypothesis.id}
              className={cn(
                "p-3 space-y-2 transition-colors",
                isRefuted && "bg-base/60 opacity-85 hover:opacity-100",
                isCorroborated && "bg-warning/5",
                isOpen && "bg-base hover:bg-sunken/20",
              )}
            >
              {/* Status Header */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {isRefuted && (
                    <span className="flex items-center gap-1 rounded-[3px] border border-stable/40 bg-stable/10 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-stable">
                      <CheckCircle2 size={10} className="text-stable" />
                      REFUTED
                    </span>
                  )}
                  {isCorroborated && (
                    <span className="flex items-center gap-1 rounded-[3px] border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-mono font-semibold text-warning">
                      <AlertTriangle size={10} className="text-warning" />
                      CORROBORATED
                    </span>
                  )}
                  {isOpen && (
                    <span className="flex items-center gap-1 rounded-[3px] border border-line-strong bg-sunken px-1.5 py-0.5 text-[9px] font-mono font-medium text-ink-3">
                      <HelpCircle size={10} className="text-ink-4" />
                      OPEN THEORY
                    </span>
                  )}
                  {item.hypothesis.entity && (
                    <span className="rounded-[2px] bg-sunken px-1 font-mono text-[9px] text-ink-3 border border-line-faint">
                      {item.hypothesis.entity}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0 text-ink-4 text-[10px] font-mono">
                  <Clock3 size={10} />
                  <span>{clockShort(item.hypothesis.at)}</span>
                </div>
              </div>

              {/* Theory text */}
              <div className="space-y-1">
                <p
                  className={cn(
                    "text-xs leading-snug",
                    isRefuted ? "line-through text-ink-4" : "text-ink font-medium",
                  )}
                >
                  {item.hypothesis.text}
                </p>

                {/* Speaker attribution */}
                <div className="flex items-center gap-1.5 text-[10px] text-ink-4">
                  <span
                    aria-hidden
                    className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border border-line bg-overlay font-mono text-[7px] font-semibold text-ink-3"
                  >
                    {initials(item.hypothesis.speakerRole)}
                  </span>
                  <span>{item.hypothesis.speakerRole}</span>
                </div>
              </div>

              {/* Telemetry Evidence / Probe Result */}
              {(isRefuted || isCorroborated) && item.evidenceClaim && (
                <div
                  className={cn(
                    "rounded border p-2 text-2xs space-y-1",
                    isRefuted
                      ? "border-stable/30 bg-stable/5 text-ink-2"
                      : "border-warning/30 bg-warning/5 text-ink-2",
                  )}
                >
                  <div className="flex items-center justify-between gap-1 text-[9px] font-mono font-semibold">
                    <span className="flex items-center gap-1">
                      <Radio size={9} className={isRefuted ? "text-stable" : "text-warning"} />
                      {item.evidenceClaim.speakerRole}
                    </span>
                    <span className="text-ink-4">{clockShort(item.evidenceClaim.at)}</span>
                  </div>
                  <p className="text-[11px] leading-tight text-ink-2">{item.evidenceClaim.text}</p>
                  {item.reason && (
                    <p className="text-[9px] text-ink-4 italic">{item.reason}</p>
                  )}
                </div>
              )}

              {/* Open state: 1-click Telemetry Probe trigger */}
              {isOpen && (
                <div className="flex items-center justify-between gap-2 rounded border border-line-faint bg-sunken/40 p-2 text-2xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 text-[10px] font-medium text-ink-2">
                      <Radio size={10} className="text-ink-4" />
                      <span>{item.suggestedProbe?.provider || "Datadog APM"} Probe Available</span>
                    </div>
                    <p className="text-[9px] text-ink-4 truncate">
                      Query live {item.suggestedProbe?.metric || "health"} on {item.suggestedProbe?.label || item.hypothesis.entity}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleProbe(item)}
                    disabled={isCurrentProbing}
                    className="h-6 shrink-0 gap-1 px-2 text-[10px] font-mono font-medium hover:border-line-strong hover:bg-surface"
                  >
                    {isCurrentProbing ? (
                      <>
                        <Loader2 size={10} className="animate-spin" />
                        <span>Probing...</span>
                      </>
                    ) : (
                      <>
                        <Radio size={10} className="text-stable" />
                        <span>Run Probe</span>
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

