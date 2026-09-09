"use client";

import { useState } from "react";
import { Clock3, Crosshair, ListChecks, Scale } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import {
  selectOpenHypotheses,
  selectOpenTasks,
} from "@/lib/incident-reducer";
import { cn } from "@/lib/cn";
import { PanelHeader } from "@/components/ui/Panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { LedgerPanel } from "./LedgerPanel";
import { GapsPanel } from "./GapsPanel";
import { TasksPanel } from "./TasksPanel";
import { TimelinePanel } from "./TimelinePanel";

/**
 * The right-hand intelligence column.
 * Modernized with shadcn Tabs and Badge primitives.
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
    <div className="flex flex-col h-full min-h-0">
      <PanelHeader
        title="Incident intelligence"
        aside={
          <span className="tnum font-mono text-2xs text-ink-4">
            {state.claims.length} claims
          </span>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList className="w-full h-8 justify-between p-1 bg-sunken/60 border-b border-line-faint rounded-none border-x-0 border-t-0 gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger
              key={id}
              value={id}
              className={cn(
                "flex-1 text-2xs gap-1 py-1 font-medium select-none cursor-pointer",
                "data-[state=active]:bg-raised data-[state=active]:text-ink data-[state=active]:shadow-xs",
              )}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span>{label}</span>
              {counts[id] > 0 ? (
                <Badge
                  variant={isWarning[id] ? "warning" : "neutral"}
                  className="px-1 py-0 text-[8px] font-mono leading-tight ml-0.5"
                >
                  {counts[id]}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="ledger" className="mt-0 flex-1 min-h-0 overflow-hidden">
          <LedgerPanel />
        </TabsContent>
        <TabsContent value="gaps" className="mt-0 flex-1 min-h-0 overflow-hidden">
          <GapsPanel />
        </TabsContent>
        <TabsContent value="actions" className="mt-0 flex-1 min-h-0 overflow-hidden">
          <TasksPanel />
        </TabsContent>
        <TabsContent value="timeline" className="mt-0 flex-1 min-h-0 overflow-hidden">
          <TimelinePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
