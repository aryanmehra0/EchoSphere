"use client";

import { useEffect, useMemo } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Database,
  Globe,
  Network,
  Route,
  Server,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { cn } from "@/lib/cn";
import { Dot, statusTone } from "@/components/ui/Signal";
import { clockShort, initials, pct } from "@/lib/format";
import type { EntityKind, EntityStatus } from "@/lib/types";

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

const METRIC_TONE: Record<EntityStatus, string> = {
  CRITICAL: "text-critical",
  WARNING: "text-warning",
  OK: "text-stable",
  UNKNOWN: "text-ink-3",
};

export function GraphInspector() {
  const { state, selectedEntityId, setSelectedEntityId } = useIncident();

  // Pressing Escape closes the inspector
  useEffect(() => {
    if (!selectedEntityId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedEntityId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedEntityId, setSelectedEntityId]);

  const entity = useMemo(
    () => state.entities.find((e) => e.id === selectedEntityId),
    [state.entities, selectedEntityId],
  );

  const entityClaims = useMemo(
    () => (entity ? state.claims.filter((c) => c.entity === entity.id) : []),
    [state.claims, entity],
  );

  const established = useMemo(
    () => entityClaims.filter((c) => c.epistemicStatus === "OBSERVED" || c.epistemicStatus === "TOOL_RESULT"),
    [entityClaims],
  );

  const hypotheses = useMemo(
    () => entityClaims.filter((c) => c.epistemicStatus === "HYPOTHESIS"),
    [entityClaims],
  );

  const inferences = useMemo(
    () => entityClaims.filter((c) => c.epistemicStatus === "INFERRED"),
    [entityClaims],
  );

  const activeContradictions = useMemo(() => {
    if (!entity) return [];
    const claimIds = new Set(entityClaims.map((c) => c.id));
    return state.contradictions.filter(
      (c) => !c.resolved && (claimIds.has(c.claimA) || claimIds.has(c.claimB)),
    );
  }, [state.contradictions, entityClaims, entity]);

  const upstreamLinks = useMemo(
    () => (entity ? state.links.filter((l) => l.target === entity.id) : []),
    [state.links, entity],
  );

  const downstreamLinks = useMemo(
    () => (entity ? state.links.filter((l) => l.source === entity.id) : []),
    [state.links, entity],
  );

  const entityMap = useMemo(
    () => new Map(state.entities.map((e) => [e.id, e])),
    [state.entities],
  );

  if (!entity) return null;

  const Glyph = GLYPH[entity.kind] ?? Server;
  const kindLabel = KIND_LABEL[entity.kind] ?? "Entity";
  const metricTone = METRIC_TONE[entity.status] ?? METRIC_TONE.UNKNOWN;

  return (
    <div
      className={cn(
        "pointer-events-auto absolute top-12 right-3 z-20 w-84 max-h-[calc(100%-3.5rem)]",
        "flex flex-col overflow-hidden rounded-lg border border-line bg-raised/95 shadow-xl backdrop-blur-md",
        "animate-in fade-in slide-in-from-right-2 duration-150 ease-out",
      )}
      role="region"
      aria-label={`Entity Inspector: ${entity.label}`}
    >
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-line bg-surface/80 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line-faint bg-sunken text-ink-3"
          >
            <Glyph size={12} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold text-ink">{entity.label}</span>
              <Dot
                tone={statusTone[entity.status] ?? "neutral"}
                pulse={entity.status === "CRITICAL"}
                label={`Status ${entity.status.toLowerCase()}`}
              />
            </div>
            <p className="truncate font-mono text-[9px] text-ink-4">
              {entity.detail ?? kindLabel}
            </p>
          </div>
        </div>

        <button
          onClick={() => setSelectedEntityId(null)}
          className="flex h-5 w-5 items-center justify-center rounded text-ink-4 transition-colors hover:bg-overlay hover:text-ink cursor-pointer"
          aria-label="Close inspector"
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>

      {/* ── Scrollable Body ───────────────────────────────────────────────── */}
      <div className="overflow-y-auto divide-y divide-line-faint p-3 space-y-3">
        {/* Metric / Status readout */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] uppercase tracking-wider text-ink-4 font-mono">
            Telemetry
          </span>
          <span className={cn("font-mono text-xs font-semibold tnum", metricTone)}>
            {entity.metric || "Normal (no alert)"}
          </span>
        </div>

        {/* Active Contradiction Banner */}
        {activeContradictions.length > 0 && (
          <div className="rounded border border-warning/40 bg-warning/10 p-2 text-2xs">
            <div className="flex items-center gap-1.5 font-semibold text-warning">
              <AlertTriangle size={12} strokeWidth={2.2} />
              <span>Contested Evidence ({activeContradictions.length})</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-2">
              Claims concerning this entity are in tension. Adjudication is open on the live bridge.
            </p>
          </div>
        )}

        {/* Epistemic Ledger Attribution */}
        <div className="pt-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-ink-4 font-mono">
              Attributed Claims ({entityClaims.length})
            </span>
            <span className="text-[9px] text-ink-4 font-mono">
              {established.length} est · {hypotheses.length} hyp · {inferences.length} inf
            </span>
          </div>

          {entityClaims.length === 0 ? (
            <p className="text-[10px] text-ink-4 italic">No direct claims attributed yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {entityClaims.map((c) => (
                <div
                  key={c.id}
                  className="rounded border border-line-faint bg-sunken/60 p-1.5 text-2xs space-y-1"
                >
                  <p className="text-[11px] leading-snug text-ink-2">{c.text}</p>
                  <div className="flex items-center justify-between text-[8.5px] font-mono text-ink-4">
                    <span className="flex items-center gap-1">
                      <span className="rounded bg-overlay px-1 py-0.2 text-ink-3">
                        {initials(c.speakerRole)}
                      </span>
                      <span>{c.speakerRole}</span>
                    </span>
                    <span className="tnum">{clockShort(c.at)} · {pct(c.confidence)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Topology: Upstream Callers & Downstream Dependencies */}
        <div className="pt-2 space-y-2">
          <span className="text-[10px] uppercase tracking-wider text-ink-4 font-mono">
            Topology Connections
          </span>

          {upstreamLinks.length === 0 && downstreamLinks.length === 0 ? (
            <p className="text-[10px] text-ink-4 italic">No directional links connected.</p>
          ) : (
            <div className="space-y-1 text-2xs">
              {upstreamLinks.map((l) => {
                const src = entityMap.get(l.source);
                return (
                  <div
                    key={l.id}
                    className="flex items-center justify-between rounded bg-sunken/40 px-2 py-1 text-[10px]"
                  >
                    <span className="flex items-center gap-1 text-ink-3">
                      <ArrowUpRight size={10} className="text-ink-4" />
                      Caller: <strong className="text-ink">{src?.label ?? l.source}</strong>
                    </span>
                    <span className="font-mono text-[9px] text-ink-4">{l.label || l.kind}</span>
                  </div>
                );
              })}

              {downstreamLinks.map((l) => {
                const tgt = entityMap.get(l.target);
                return (
                  <div
                    key={l.id}
                    className="flex items-center justify-between rounded bg-sunken/40 px-2 py-1 text-[10px]"
                  >
                    <span className="flex items-center gap-1 text-ink-3">
                      <ArrowDownRight size={10} className="text-ink-4" />
                      Calls: <strong className="text-ink">{tgt?.label ?? l.target}</strong>
                    </span>
                    <span className="font-mono text-[9px] text-ink-4">{l.label || l.kind}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Action / Cross-Filter Footer */}
        <div className="pt-2 text-[10px] text-ink-4 flex items-center justify-between">
          <span>Ledger filtered to this entity</span>
          <button
            onClick={() => setSelectedEntityId(null)}
            className="text-live hover:underline cursor-pointer font-mono"
          >
            Clear selection (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
