"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { Crosshair, GitBranch, Maximize2 } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntityNode, type EntityNodeType } from "./EntityNode";
import { GraphLegend } from "./GraphLegend";
import type { EdgeKind, EntityStatus } from "@/lib/types";

/**
 * The root-cause knowledge graph.
 *
 * The graph is a PROJECTION of incident state, never a second copy of it.
 * React Flow's `useNodesState` would give us a mutable local store that drifts
 * from the reducer the moment a delta and a drag land in the same frame, so
 * nodes and edges are derived with `useMemo` and the canvas is read-only:
 * pan, zoom and select, but no dragging or hand-wiring.
 *
 * That is a product decision as much as a technical one. This graph is the
 * team's shared understanding of a live outage, extracted from what people
 * actually said. If an operator can drag an edge onto it by hand, it stops
 * being evidence.
 */

const nodeTypes = { entity: EntityNode };

/** Edge stroke follows the DOWNSTREAM entity's status — the thing at risk. */
const EDGE_STROKE: Record<EntityStatus, string> = {
  CRITICAL: "var(--color-critical)",
  WARNING: "var(--color-warning)",
  OK: "var(--color-stable)",
  UNKNOWN: "var(--color-ink-4)",
};

const EDGE_STYLE: Record<EdgeKind, { dashed: boolean; width: number }> = {
  causal: { dashed: false, width: 1.6 },
  suspected: { dashed: true, width: 1.4 },
  depends: { dashed: false, width: 1.2 },
};

/**
 * Fallback layout for entities the pipeline gave no coordinates.
 *
 * A grid rather than a circle or a force simulation: it is deterministic, so
 * a node keeps its place as the incident grows, and `fitView` below frames
 * whatever exists. Three columns keeps a typical 3–6 entity incident close to
 * square in a panel that is taller than it is wide.
 *
 * Spacing is generous because `EntityNode` cards carry a label, a status dot
 * and sometimes a metric; tighter values overlapped the cards, which looks
 * like the same bug this replaced.
 */
const GRID_COLUMNS = 3;
const GRID_X = 260;
const GRID_Y = 150;

function gridPosition(index: number): { x: number; y: number } {
  return {
    x: (index % GRID_COLUMNS) * GRID_X,
    y: Math.floor(index / GRID_COLUMNS) * GRID_Y,
  };
}

function Canvas() {
  const { state } = useIncident();
  const { fitView } = useReactFlow();

  const nodes = useMemo<EntityNodeType[]>(
    () =>
      state.entities.map((e, i) => ({
        id: e.id,
        type: "entity" as const,
        /*
          ── EVERY NODE NEEDS ITS OWN COORDINATES ─────────────────────────
          This was `e.position ?? { x: 0, y: 0 }`, and NOTHING sets
          `position`: the backend's `Entity.position` is optional and the
          extraction pipeline never fills it in. So every entity fell to the
          same fallback and they stacked exactly on top of each other at the
          origin.

          Reported as "only one node appears in the graph". The header was
          reading `4n · 1e` at the time, which was correct — four nodes
          existed, three were hidden underneath the fourth. The count and the
          canvas disagreed, and the count was right.

          A server-supplied position still wins, so a future layout pass on
          the Slow Loop needs no change here. Absent one, nodes are laid out
          on a grid derived from their INDEX, which is stable: entity order
          is preserved across deltas (there is a test for that), so a node
          does not jump around as the incident grows.
        */
        position: e.position ?? gridPosition(i),
        data: e,
        draggable: false,
        selectable: true,
      })),
    [state.entities],
  );

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(state.entities.map((e) => [e.id, e]));
    // The SAME positions the nodes were rendered with. Reading `e.position`
    // here would be undefined for every grid-placed node, so `dx`/`dy` both
    // came out 0 and every edge picked the same handle pair regardless of
    // which way it actually travelled.
    const placed = new Map(
      state.entities.map((e, i) => [e.id, e.position ?? gridPosition(i)]),
    );

    return state.links.map((l) => {
      // `src` is gone: its only use was reading `.position`, which is now
      // taken from `placed` above so grid-laid-out nodes route correctly.
      const tgt = byId.get(l.target);
      const status = tgt?.status ?? "UNKNOWN";
      const stroke = EDGE_STROKE[status];
      const shape = EDGE_STYLE[l.kind];

      // Choose the handle pair facing the direction of travel. Without this,
      // a link to the node directly above exits rightward and loops back over
      // its own source card.
      const dx = (placed.get(l.target)?.x ?? 0) - (placed.get(l.source)?.x ?? 0);
      const dy = (placed.get(l.target)?.y ?? 0) - (placed.get(l.source)?.y ?? 0);
      const horizontal = Math.abs(dx) >= Math.abs(dy);

      const sourceHandle = horizontal
        ? dx >= 0 ? "s-r" : "s-l"
        : dy >= 0 ? "s-b" : "s-t";
      const targetHandle = horizontal
        ? dx >= 0 ? "t-l" : "t-r"
        : dy >= 0 ? "t-t" : "t-b";

      return {
        id: l.id,
        source: l.source,
        target: l.target,
        sourceHandle,
        targetHandle,
        label: l.label,
        type: "smoothstep",
        animated: false,
        // The travelling-dash treatment for unconfirmed links is CSS, not the
        // `animated` prop, so it can be disabled by prefers-reduced-motion.
        className: l.kind === "suspected" ? "edge-suspected" : undefined,
        style: { stroke, strokeWidth: shape.width },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: stroke,
        },
      } satisfies Edge;
    });
  }, [state.links, state.entities]);

  /**
   * Re-frame the canvas when the graph GROWS, but not when a node merely
   * changes status. Re-fitting on every delta would pan the view out from
   * under an operator who is reading a specific node.
   */
  const lastCount = useRef(0);
  useEffect(() => {
    if (nodes.length !== lastCount.current) {
      lastCount.current = nodes.length;
      if (nodes.length > 0) {
        const id = window.setTimeout(
          () => fitView({ padding: 0.12, duration: 420, maxZoom: 1.15 }),
          60,
        );
        return () => window.clearTimeout(id);
      }
    }
  }, [nodes.length, fitView]);

  const empty = state.entities.length === 0;

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes as unknown as Node[]}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        panOnScroll
        selectionOnDrag={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.35}
        maxZoom={1.8}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.15 }}
      >
        {/* A fine dot grid rather than React Flow's default lines: it reads as
            graph paper under the nodes without competing with the edges. */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="var(--color-line)"
        />
      </ReactFlow>

      {/* ── Canvas chrome ─────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-sm border border-line bg-raised/90 px-2.5 py-1.5 backdrop-blur-[2px]">
            <GitBranch size={11} strokeWidth={2.2} className="text-ink-4" />
            <span className="eyebrow">Root-cause graph</span>
            <span className="tnum ml-1 font-mono text-2xs text-ink-4">
              {state.entities.length}n · {state.links.length}e
            </span>
          </div>

          <div className="pointer-events-auto flex items-center gap-1.5">
            <GraphLegend />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => fitView({ padding: 0.12, duration: 420 })}
              aria-label="Fit graph to view"
              title="Fit graph to view"
              className="h-6 w-6 px-0"
              icon={<Maximize2 size={11} strokeWidth={2.2} />}
            />
          </div>
        </div>
      </div>

      {/* Empty state sits above the canvas so the dot grid still shows through
          — the surface reads as ready rather than broken. */}
      {empty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto rounded-md border border-line bg-raised/80 backdrop-blur-[2px]">
            <EmptyState
              icon={<Crosshair size={13} strokeWidth={2} />}
              title="No entities extracted"
              hint="Infrastructure named on the bridge is plotted here as Echo identifies it."
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function GraphCanvas({ className }: { className?: string }) {
  return (
    <div className={cn("relative h-full w-full", className)}>
      {/* Provider must wrap the component that calls useReactFlow. */}
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </div>
  );
}
