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

function Canvas() {
  const { state } = useIncident();
  const { fitView } = useReactFlow();

  const nodes = useMemo<EntityNodeType[]>(
    () =>
      state.entities.map((e) => ({
        id: e.id,
        type: "entity" as const,
        position: e.position ?? { x: 0, y: 0 },
        data: e,
        draggable: false,
        // Entities the LLM discovers late have no layout hint; they land at the
        // origin rather than being silently dropped, which makes the gap
        // visible instead of mysterious.
        selectable: true,
      })),
    [state.entities],
  );

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(state.entities.map((e) => [e.id, e]));

    return state.links.map((l) => {
      const src = byId.get(l.source);
      const tgt = byId.get(l.target);
      const status = tgt?.status ?? "UNKNOWN";
      const stroke = EDGE_STROKE[status];
      const shape = EDGE_STYLE[l.kind];

      // Choose the handle pair facing the direction of travel. Without this,
      // a link to the node directly above exits rightward and loops back over
      // its own source card.
      const dx = (tgt?.position?.x ?? 0) - (src?.position?.x ?? 0);
      const dy = (tgt?.position?.y ?? 0) - (src?.position?.y ?? 0);
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
