"use client";

import { useState } from "react";
import { Clock3, Crosshair, ListChecks, Scale } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import {
  selectOpenHypotheses,
  selectOpenTasks,
} from "@/lib/incident-reducer";
import { cn } from "@/lib/cn";
import { PanelBody, PanelHeader } from "@/components/ui/Panel";
import { LedgerPanel } from "./LedgerPanel";
import { GapsPanel } from "./GapsPanel";
import { TasksPanel } from "./TasksPanel";
import { TimelinePanel } from "./TimelinePanel";

/**
 * The right-hand intelligence column.
 *
 * Four dense datasets compete for one column. Stacking them means four cramped
 * scroll areas and nothing readable; plain tabs mean three of the four are
 * invisible and therefore forgotten. The compromise is a segmented control with
 * LIVE COUNTS on the inactive segments — you always know there are two
 * unchecked gaps while reading the timeline, so nothing hides.
 *
 * "Gaps" earns its own segment rather than living inside the Ledger because it
 * answers a different question. The Ledger says what is known; Gaps says what
 * is not, and v6 makes that a first-class output (§9.4) rather than an absence
 * the reader has to infer.
 */

type Tab = "ledger" | "gaps" | "actions" | "timeline";

const TABS: {
  id: Tab;
  label: string;
  icon: typeof Scale;
}[] = [
  { id: "ledger", label: "Ledger", icon: Scale },
  { id: "gaps", label: "Gaps", icon: Crosshair },
  { id: "actions", label: "Actions", icon: ListChecks },
  { id: "timeline", label: "Time", icon: Clock3 },
];

export function IntelColumn() {
  const [tab, setTab] = useState<Tab>("ledger");
  const { state } = useIncident();

  const counts: Record<Tab, number> = {
    ledger: selectOpenHypotheses(state).length,
    gaps: state.unchecked.length,
    actions: selectOpenTasks(state).length,
    timeline: state.timeline.length,
  };

  /** Only counts representing OUTSTANDING work are toned as warnings. */
  const isWarning: Record<Tab, boolean> = {
    ledger: counts.ledger > 0,
    gaps: counts.gaps > 0,
    actions: counts.actions > 0,
    timeline: false,
  };

  return (
    <>
      <PanelHeader
        title="Incident intelligence"
        aside={
          <span className="tnum font-mono text-2xs text-ink-4">
            {state.claims.length} claims
          </span>
        }
      />

      {/* Segmented control */}
      <div
        role="tablist"
        aria-label="Incident intelligence views"
        className="flex shrink-0 gap-px border-b border-line-faint bg-sunken/50 p-1"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              role="tab"
              type="button"
              id={`tab-${id}`}
              aria-selected={active}
              aria-controls={`panel-${id}`}
              onClick={() => setTab(id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1 rounded-xs px-1.5 py-1.5",
                "text-2xs font-medium transition-colors duration-150 ease-[var(--ease-out)]",
                active
                  ? "bg-raised text-ink shadow-[inset_0_1px_0_0_oklch(1_0_0/6%)]"
                  : "text-ink-3 hover:bg-hover/60 hover:text-ink-2",
              )}
            >
              <Icon size={11} strokeWidth={2.2} />
              {label}
              {counts[id] > 0 ? (
                <span
                  className={cn(
                    "tnum rounded-[2px] px-1 font-mono text-[9px] leading-[14px]",
                    isWarning[id]
                      ? "bg-warning/15 text-warning"
                      : "bg-line text-ink-3",
                  )}
                >
                  {counts[id]}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <PanelBody
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "ledger" ? <LedgerPanel /> : null}
        {tab === "gaps" ? <GapsPanel /> : null}
        {tab === "actions" ? <TasksPanel /> : null}
        {tab === "timeline" ? <TimelinePanel /> : null}
      </PanelBody>
    </>
  );
}
