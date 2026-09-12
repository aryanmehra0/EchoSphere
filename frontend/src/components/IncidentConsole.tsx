"use client";

import { Activity } from "lucide-react";

import { AuthProvider } from "@/lib/auth-context";
import { IncidentProvider } from "@/lib/incident-store";
import { CommandBar } from "@/components/shell/CommandBar";
import { StatusBar } from "@/components/shell/StatusBar";
import { BridgeControls } from "@/components/voice/BridgeControls";
import { AgentPresence } from "@/components/voice/AgentPresence";
import { WarRoomRoster } from "@/components/voice/WarRoomRoster";
import { TranscriptFeed } from "@/components/voice/TranscriptFeed";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { ContradictionAlert } from "@/components/intel/ContradictionAlert";
import { ApprovalModal } from "@/components/intel/ApprovalModal";
import { PostMortemModal } from "@/components/intel/PostMortemModal";
import { HistoricalSearchModal } from "@/components/intel/HistoricalSearchModal";
import { ProjectWorkspaceModal } from "@/components/shell/ProjectWorkspaceModal";
import { IntelColumn } from "@/components/intel/IntelColumn";
import { Panel, PanelHeader } from "@/components/ui/Panel";

/**
 * The console shell.
 *
 * LAYOUT REASONING
 * ────────────────
 * A fixed-frame, three-column grid that never scrolls as a page — only the
 * panes scroll. This is the defining structural choice of an operations tool:
 * an operator must be able to look at the same physical spot on the screen and
 * find the same information, every time, without scrolling to hunt for it.
 *
 * Columns are ordered by how often they are read, left to right:
 *
 *   VOICE (352px)  — the input. Fixed width; a transcript needs a stable
 *                    measure or the eye loses its place on every reflow.
 *   GRAPH (fluid)  — the shared understanding. Takes all remaining space
 *                    because it is the thing being projected in the room.
 *   INTEL (376px)  — the output. Slightly wider than the left column since it
 *                    carries three datasets, and dense rows need the measure.
 *
 * The contradiction alert is the one element that breaks the grid, docking
 * over the graph's lower edge — see ContradictionAlert for why.
 */
export function IncidentConsole() {
  return (
    <AuthProvider>
      <IncidentProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-base">
        <CommandBar />

        <div className="flex min-h-0 flex-1">
          {/* ── Voice ─────────────────────────────────────────────────────── */}
          <Panel className="w-[352px] shrink-0 border-r border-line bg-base">
            <PanelHeader
              title="Voice bridge"
              icon={<Activity size={11} strokeWidth={2.2} />}
            />

            <div className="flex flex-col gap-2 border-b border-line-faint p-2.5">
              <BridgeControls />
              <AgentPresence />
              <WarRoomRoster />
            </div>

            <TranscriptFeed />
          </Panel>

          {/* ── Graph ─────────────────────────────────────────────────────── */}
          <div className="relative min-w-0 flex-1 bg-void">
            <GraphCanvas />

            {/* Alert dock. `pointer-events-none` on the rail so the canvas
                stays draggable through the empty space either side of it. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
              <ContradictionAlert />
            </div>
          </div>

          {/* ── Intelligence ──────────────────────────────────────────────── */}
          <Panel className="w-[376px] shrink-0 border-l border-line bg-base">
            <IntelColumn />
          </Panel>
        </div>

        {/* The Authorization Gate overlays everything: a CRITICAL action
            waiting on a human is the one thing that should interrupt reading
            the graph. It has no dismiss control — Approve, Deny, or expire. */}
        <ApprovalModal />

        {/* Automated Post-Mortem & SOC2 Audit Report Export Modal */}
        <PostMortemModal />

        {/* Cross-Incident Semantic RAG Search Modal */}
        <HistoricalSearchModal />

        {/* Enterprise Project Workspace & Connectors Modal */}
        <ProjectWorkspaceModal />

        <StatusBar />
      </div>
    </IncidentProvider>
    </AuthProvider>
  );
}
