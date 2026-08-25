"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  Database,
  Globe,
  Network,
  Route,
  Server,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { Dot, statusTone } from "@/components/ui/Signal";
import type { EntityKind, EntityStatus, IncidentEntity } from "@/lib/types";

/**
 * A node on the root-cause graph.
 *
 * React Flow's default node is a white rounded rectangle with centred text —
 * fine for a flowchart demo, useless for an operations console. This replaces
 * it with a purpose-built instrument that answers three questions at a glance:
 *
 *   WHAT is it   → glyph + label + kind
 *   WHERE is it  → the mono `detail` line (region, service id)
 *   HOW is it    → the status stripe, which is the widest, highest-contrast
 *                  element on the card and is readable from the back of a room
 *
 * The stripe carries status redundantly with the dot and the metric colour, so
 * the graph survives both projector colour-shift and colour-blind operators.
 *
 * `memo` matters here: a delta arriving every few seconds re-renders the graph,
 * and without it every node in the canvas reconciles on each frame of a drag.
 */

export type EntityNodeData = IncidentEntity & Record<string, unknown>;
export type EntityNodeType = Node<EntityNodeData, "entity">;

const GLYPH: Record<EntityKind, LucideIcon> = {
  service: Server,
  datastore: Database,
  network: Network,
  gateway: Route,
  region: Globe,
  client: Users,
};

const KIND_LABEL: Record<EntityKind, string> = {
  service: "Service",
  datastore: "Datastore",
  network: "Network",
  gateway: "Gateway",
  region: "Region",
  client: "Client",
};

/** Border + stripe treatment per status. */
const SHELL: Record<EntityStatus, string> = {
  CRITICAL: "border-critical/45",
  WARNING: "border-warning/40",
  OK: "border-stable/35",
  UNKNOWN: "border-line",
};

const STRIPE: Record<EntityStatus, string> = {
  CRITICAL: "bg-critical",
  WARNING: "bg-warning",
  OK: "bg-stable",
  UNKNOWN: "bg-ink-4",
};

const METRIC: Record<EntityStatus, string> = {
  CRITICAL: "text-critical",
  WARNING: "text-warning",
  OK: "text-stable",
  UNKNOWN: "text-ink-3",
};

function EntityNodeImpl({ data }: NodeProps<EntityNodeType>) {
  const Glyph = GLYPH[data.kind];
  const critical = data.status === "CRITICAL";

  return (
    <div
      className={cn(
        "node-shell relative w-[184px] overflow-hidden rounded-md border bg-raised",
        "shadow-[inset_0_1px_0_0_oklch(1_0_0/5%),0_1px_2px_0_oklch(0_0_0/40%)]",
        "transition-[border-color,box-shadow] duration-300 ease-[var(--ease-out)]",
        SHELL[data.status],
        // The only glow in the system, reserved for confirmed failure.
        critical && "shadow-[0_0_0_1px_var(--color-critical)/20,0_0_28px_-10px_var(--color-critical)]",
      )}
      // The node is a summary; the accessible name states everything the
      // visual encoding does, in order of importance.
      role="group"
      aria-label={`${data.label}, ${KIND_LABEL[data.kind]}, status ${data.status}${
        data.metric ? `, ${data.metric}` : ""
      }`}
    >
      {/* Status stripe — the primary, non-textual health signal. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[3px] transition-colors duration-300",
          STRIPE[data.status],
        )}
      />

      <div className="flex items-start gap-2 py-2 pr-2 pl-3">
        <span
          aria-hidden
          className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-xs border border-line-faint bg-sunken text-ink-3"
        >
          <Glyph size={12} strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-xs leading-tight font-semibold text-ink">
              {data.label}
            </p>
            <Dot
              tone={statusTone[data.status]}
              pulse={critical}
              className="ml-auto"
              label={`Status ${data.status.toLowerCase()}`}
            />
          </div>

          <p className="mt-0.5 truncate font-mono text-[9px] tracking-tight text-ink-4">
            {data.detail ?? KIND_LABEL[data.kind]}
          </p>
        </div>
      </div>

      {/* Metric footer. Present only when the analytics loop attached one, so
          nodes without telemetry stay compact instead of showing an empty rail. */}
      {data.metric ? (
        <div className="flex items-center justify-between border-t border-line-faint bg-sunken/60 py-1 pr-2 pl-3">
          <span className="text-[9px] tracking-[0.08em] text-ink-4 uppercase">
            {KIND_LABEL[data.kind]}
          </span>
          <span
            className={cn(
              "tnum font-mono text-[9px] font-medium",
              METRIC[data.status],
            )}
          >
            {data.metric}
          </span>
        </div>
      ) : null}

      {/*
        A source AND a target handle on all four sides.

        React Flow's default pairing (source right, target left) forces every
        edge to exit rightward, which is what makes a graph route its arrows
        back through the card it just left. With all eight anchors available,
        GraphCanvas can pick the pair facing the direction of travel, so a link
        to the node directly above leaves through the top and arrives at the
        bottom — a straight line instead of a detour.

        This matters more in Phase 3 than it does today: the analytics loop
        decides the layout, and the canvas has to stay legible for whatever
        arrangement it produces. Handles are hidden until hover (globals.css).
      */}
      <Handle type="source" position={Position.Left} id="s-l" />
      <Handle type="source" position={Position.Right} id="s-r" />
      <Handle type="source" position={Position.Top} id="s-t" />
      <Handle type="source" position={Position.Bottom} id="s-b" />

      <Handle type="target" position={Position.Left} id="t-l" />
      <Handle type="target" position={Position.Right} id="t-r" />
      <Handle type="target" position={Position.Top} id="t-t" />
      <Handle type="target" position={Position.Bottom} id="t-b" />
    </div>
  );
}

export const EntityNode = memo(EntityNodeImpl);
