"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Crosshair, GitBranch, Maximize2, Layers, ChevronDown, Check } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { cn } from "@/lib/cn";
import { computeGraphLayout, type NodePosition } from "@/lib/graph-layout";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TOPOLOGY_SCENARIOS } from "@/lib/topology-scenarios";
import { EntityNode, type EntityNodeType } from "./EntityNode";
import { GraphInspector } from "./GraphInspector";
import { GraphLegend } from "./GraphLegend";
import type { EdgeKind, EntityStatus, Scenario } from "@/lib/types";

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
  const { state, dispatch, selectedEntityId, setSelectedEntityId } = useIncident();
  const { fitView } = useReactFlow();
  const [manualPositions, setManualPositions] = useState<Record<string, NodePosition>>({});
  const [activeScenarioId, setActiveScenarioId] = useState<string>("clean");

  const activeScenario = useMemo(
    () => TOPOLOGY_SCENARIOS.find((s) => s.id === activeScenarioId) ?? TOPOLOGY_SCENARIOS[0],
    [activeScenarioId],
  );

  const handleSelectScenario = useCallback(
    (scenario: Scenario) => {
      setActiveScenarioId(scenario.id);
      dispatch({ type: "LOAD_SCENARIO", scenario });
      if (scenario.entities.length > 0) {
        window.setTimeout(() => fitView({ padding: 0.12, duration: 420, maxZoom: 1.15 }), 80);
      }
    },
    [dispatch, fitView],
  );

  const contestedEntityIds = useMemo(() => {
    const claimEntityMap = new Map(state.claims.map((c) => [c.id, c.entity]));
    const contested = new Set<string>();
    for (const c of state.contradictions) {
      if (!c.resolved) {
        const entA = claimEntityMap.get(c.claimA);
        const entB = claimEntityMap.get(c.claimB);
        if (entA) contested.add(entA);
        if (entB) contested.add(entB);
      }
    }
    return contested;
  }, [state.claims, state.contradictions]);

  const activeNeighborhood = useMemo(() => {
    if (!selectedEntityId) return null;
    const neighbors = new Set<string>([selectedEntityId]);
    for (const l of state.links) {
      if (l.source === selectedEntityId) neighbors.add(l.target);
      if (l.target === selectedEntityId) neighbors.add(l.source);
    }
    return neighbors;
  }, [selectedEntityId, state.links]);

  const layoutPositions = useMemo(
    () => computeGraphLayout(state.entities, state.links, manualPositions),
    [state.entities, state.links, manualPositions],
  );

  const nodes = useMemo<EntityNodeType[]>(
    () =>
      state.entities.map((e) => {
        const pos = layoutPositions.get(e.id) ?? { x: 0, y: 0 };
        const isSelected = selectedEntityId === e.id;
        const isDimmed = activeNeighborhood ? !activeNeighborhood.has(e.id) : false;
        const isContested = contestedEntityIds.has(e.id);

        return {
          id: e.id,
          type: "entity" as const,
          position: pos,
          data: {
            ...e,
            isContested,
            isDimmed,
            isSelected,
          },
          draggable: true,
          selectable: true,
        };
      }),
    [state.entities, layoutPositions, selectedEntityId, activeNeighborhood, contestedEntityIds],
  );

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(state.entities.map((e) => [e.id, e]));

    return state.links.map((l) => {
      const tgt = byId.get(l.target);
      const status = tgt?.status ?? "UNKNOWN";
      const stroke = EDGE_STROKE[status];
      const shape = EDGE_STYLE[l.kind];

      const srcPos = layoutPositions.get(l.source) ?? { x: 0, y: 0 };
      const tgtPos = layoutPositions.get(l.target) ?? { x: 0, y: 0 };

      const dx = tgtPos.x - srcPos.x;
      const dy = tgtPos.y - srcPos.y;
      const horizontal = Math.abs(dx) >= Math.abs(dy);

      const sourceHandle = horizontal
        ? dx >= 0 ? "s-r" : "s-l"
        : dy >= 0 ? "s-b" : "s-t";
      const targetHandle = horizontal
        ? dx >= 0 ? "t-l" : "t-r"
        : dy >= 0 ? "t-t" : "t-b";

      const isConnectedToSelected = selectedEntityId
        ? l.source === selectedEntityId || l.target === selectedEntityId
        : false;
      const isEdgeDimmed = selectedEntityId ? !isConnectedToSelected : false;

      return {
        id: l.id,
        source: l.source,
        target: l.target,
        sourceHandle,
        targetHandle,
        label: l.label,
        type: "smoothstep",
        animated: false,
        className: cn(
          l.kind === "suspected" && "edge-suspected",
          isEdgeDimmed && "opacity-20 transition-opacity",
          isConnectedToSelected && "opacity-100",
        ),
        style: {
          stroke,
          strokeWidth: isConnectedToSelected ? shape.width + 0.8 : shape.width,
        },
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
  }, [state.links, state.entities, layoutPositions, selectedEntityId]);

  const onNodeDragStop = useCallback((_: MouseEvent | TouchEvent, node: Node) => {
    setManualPositions((prev) => ({
      ...prev,
      [node.id]: { x: node.position.x, y: node.position.y },
    }));
  }, []);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedEntityId(selectedEntityId === node.id ? null : node.id);
    },
    [selectedEntityId, setSelectedEntityId],
  );

  const onPaneClick = useCallback(() => {
    if (selectedEntityId) setSelectedEntityId(null);
  }, [selectedEntityId, setSelectedEntityId]);

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
        nodesDraggable={true}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
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

      {/* ── Entity Inspector Overlay ───────────────────────────────────────── */}
      <GraphInspector />

      {/* ── Canvas chrome ─────────────────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-sm border border-line bg-raised/90 px-2.5 py-1.5 backdrop-blur-[2px]">
            <GitBranch size={11} strokeWidth={2.2} className="text-ink-4" />
            <span className="eyebrow">System Topology & Evidence Graph</span>
            <span className="tnum ml-1 font-mono text-2xs text-ink-4">
              {state.entities.length}n · {state.links.length}e
            </span>
          </div>

          <div className="pointer-events-auto flex items-center gap-1.5">
            {/* ── Scenario Selector ─────────────────────────────────────── */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6 gap-1.5 px-2 font-mono text-[10px]"
                  title="Switch Pre-hydrated Architecture Topology Scenario"
                >
                  <Layers size={11} strokeWidth={2} className="text-ink-4" />
                  <span className="max-w-[130px] truncate">{activeScenario.name}</span>
                  <ChevronDown size={10} className="text-ink-4 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-ink-4">
                  Incident Topology Scenarios
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {TOPOLOGY_SCENARIOS.map((sc) => {
                  const isSelected = sc.id === activeScenarioId;
                  return (
                    <DropdownMenuItem
                      key={sc.id}
                      onClick={() => handleSelectScenario(sc)}
                      className={cn(
                        "flex flex-col items-start gap-1 p-2 cursor-pointer",
                        isSelected && "bg-hover/80",
                      )}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className="font-semibold text-xs text-ink">{sc.name}</span>
                        <div className="flex items-center gap-1">
                          <span className="rounded-[2px] border border-line px-1 py-0.2 font-mono text-[8px] text-ink-3">
                            {sc.badge}
                          </span>
                          {isSelected && <Check size={12} className="text-stable" />}
                        </div>
                      </div>
                      <p className="text-[10px] text-ink-4 leading-tight">
                        {sc.description}
                      </p>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

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
