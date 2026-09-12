"use client";

import { useEffect } from "react";
import { ChevronDown, FileText, Layers, MicOff, Radio, Search } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { Button } from "@/components/ui/Button";
import {
  selectOpenContradictions,
  selectOpenTasks,
} from "@/lib/incident-reducer";
import { elapsed } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Dot, Metric, Rule } from "@/components/ui/Signal";
import { TensionMeter } from "@/components/ui/Meter";
import { UserMenu } from "@/components/shell/UserMenu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { IncidentPhase } from "@/lib/types";

/**
 * The command bar.
 *
 * This is the one strip an operator glances at when they look up from the
 * graph, so it answers, left to right, the four questions asked during an
 * incident: *what is broken*, *how long has it been broken*, *how bad is it
 * right now*, and *is the system still listening*.
 *
 * It is deliberately not a navigation bar. There is nowhere else to go.
 */

const PHASE_LABEL: Record<IncidentPhase, string> = {
  standby: "Standby",
  triage: "Triage",
  investigating: "Investigating",
  mitigating: "Mitigating",
  resolved: "Resolved",
};

/** Phase is the incident's own state machine, so it gets its own progression. */
const PHASE_ORDER: IncidentPhase[] = [
  "triage",
  "investigating",
  "mitigating",
  "resolved",
];

function PhaseTrack({ phase }: { phase: IncidentPhase }) {
  const active = PHASE_ORDER.indexOf(phase);

  return (
    <div
      className="flex items-center gap-1.5"
      role="group"
      aria-label={`Incident phase: ${PHASE_LABEL[phase]}`}
    >
      {PHASE_ORDER.map((p, i) => {
        const reached = active >= i;
        const current = active === i;
        return (
          <div key={p} className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-2xs font-medium tracking-[0.06em] uppercase transition-colors duration-300",
                current
                  ? "text-ink"
                  : reached
                    ? "text-ink-3"
                    : "text-ink-4/60",
              )}
            >
              {PHASE_LABEL[p]}
            </span>
            {i < PHASE_ORDER.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px w-4 transition-colors duration-300",
                  reached && active > i ? "bg-ink-4" : "bg-line",
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function CommandBar() {
  const {
    state,
    now,
    setPostMortemOpen,
    historicalSearchOpen,
    setHistoricalSearchOpen,
    activeProject,
    setProjectModalOpen,
  } = useIncident();
  const openContradictions = selectOpenContradictions(state);
  const openTasks = selectOpenTasks(state);

  const live = state.bridge === "live";

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHistoricalSearchOpen(!historicalSearchOpen);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historicalSearchOpen, setHistoricalSearchOpen]);

  return (
    <header
      className={cn(
        "relative z-20 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-raised px-4",
        "shadow-[inset_0_1px_0_0_oklch(1_0_0/4%)]",
      )}
    >
      {/* ── Identity ──────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-sm border",
            live
              ? "border-live/40 bg-live/12 text-live"
              : "border-line bg-sunken text-ink-4",
          )}
          aria-hidden
        >
          <Radio size={14} strokeWidth={2} />
        </span>
        <div className="flex flex-col gap-px">
          <div className="flex items-center gap-2">
            <span className="text-sm leading-none font-semibold tracking-tight text-ink">
              Echo
            </span>
            <Badge tone="critical" variant="solid">
              Sev {state.severity}
            </Badge>
            <button
              type="button"
              onClick={() => setProjectModalOpen(true)}
              className="flex items-center gap-1.5 rounded-xs border border-line bg-sunken px-2 py-0.5 text-2xs text-ink-2 hover:border-line-strong hover:bg-raised transition-colors cursor-pointer"
              title="Open Project Workspace & Observability Connectors"
            >
              <Layers size={11} className="text-live" />
              <span className="font-medium truncate max-w-[125px]">
                {activeProject?.name || "Payments Core"}
              </span>
              <ChevronDown size={10} className="text-ink-4" />
            </button>
          </div>
          <span className="font-mono text-2xs leading-none text-ink-4">
            {state.id}
          </span>
        </div>
      </div>

      <Rule className="shrink-0" />

      {/*
        ── Headline ──────────────────────────────────────────────────────
        `overflow-hidden` is load-bearing, not decorative: this box has
        `min-w-0` so the flex row is allowed to shrink it below its
        children's natural width once the row runs out of space, but
        `PhaseTrack` has no truncation of its own (it is four labels and
        connective rules, not a single string an ellipsis can shorten). With
        `overflow: visible` (the default) a shrunk box does not clip its
        content — it just lets it render past the box edge, straight into
        the metrics block sitting to its right. That is what produced
        "MITIGATING" bleeding into "ELAPSED" in practice. Clipping here means
        the phase track is cut cleanly at the box edge under real pressure
        instead of overlapping the next element.

        `shrink-[9999]` on top of that decides WHO gives up space first.
        Plain `flex-shrink: 1` (the default) distributes the header's
        shortfall proportionally to each item's own content size — and
        because the metrics block on the right is by far the widest thing in
        the bar, that default made IT surrender space long before this much
        smaller headline gave up any, forcing the metrics row into its
        horizontal scroll fallback on perfectly ordinary laptop widths. The
        title is the one element here with a designed degrade path (an
        ellipsis); the incident metrics are not, so this box is set to
        absorb essentially all of the shrinking first, down to 0, before the
        metrics block loses a single pixel.
      */}
      <div className="flex min-w-0 shrink-[9999] flex-col gap-1 overflow-hidden">
        <h1 className="truncate text-xs leading-none font-medium text-ink-2">
          {state.title}
        </h1>
        <PhaseTrack phase={state.phase} />
      </div>

      {/*
        Everything past here is right-aligned instrumentation with rich
        tooltips.

        THIS ROW DOES NOT FIT EVERY ITEM AT EVERY WINDOW WIDTH — there are
        eleven distinct controls here, and no amount of gap-tightening makes
        that free. The old version let the flex row simply overflow the
        header, which the app shell clips with `overflow-hidden`: whatever
        didn't fit was silently cut off the right edge (the user's own
        screenshot caught `UserMenu` and the Post-Mortem button half-gone).

        Two changes fix that structurally rather than cosmetically:
          1. `min-w-0` on this container lets the flex algorithm actually
             shrink it (the header's headline block truncates first, since
             it already carries `truncate`), and `overflow-x-auto` turns
             whatever doesn't fit into an internal scroll instead of a
             layout overflow the ancestor clips.
          2. Every child gets `shrink-0` so the shrinking above never
             compresses a metric or a label below its own content width —
             that compression is what produced the overlapping/garbled text
             in the screenshot, not this container's overall size.
          3. The least essential labels (connector-chip text, button
             captions, the ⌘K hint) hide progressively below `lg`/`xl`,
             which keeps the row inside common laptop widths as icon+tooltip
             affordances, so the scrollbar fallback rarely has to be used.
      */}
      <TooltipProvider delayDuration={150}>
        <div className="scroll-thin ml-auto flex min-w-0 items-center gap-3 overflow-x-auto">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="shrink-0 cursor-default">
                <Metric
                  label="Elapsed"
                  value={elapsed(state.startedAt, now)}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>Time since the incident bridge opened</TooltipContent>
          </Tooltip>

          <Rule className="shrink-0" />

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="shrink-0 cursor-default">
                <Metric
                  label="Conflicts"
                  value={openContradictions.length.toString().padStart(2, "0")}
                  tone={openContradictions.length > 0 ? "warning" : "neutral"}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>Unresolved contradictions detected by the semantic engine</TooltipContent>
          </Tooltip>

          {/* Requirement 5 has two halves. Conflicts is the loud one; Gaps is
              what nobody has checked, and it belongs beside it at the top level
              rather than buried a tab deep. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="shrink-0 cursor-default">
                <Metric
                  label="Gaps"
                  value={state.unchecked.length.toString().padStart(2, "0")}
                  tone={state.unchecked.length > 0 ? "warning" : "neutral"}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>Things nobody on the bridge has established yet</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="shrink-0 cursor-default">
                <Metric
                  label="Open"
                  value={openTasks.length.toString().padStart(2, "0")}
                  tone={openTasks.length > 0 ? "live" : "neutral"}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>Action items not yet closed</TooltipContent>
          </Tooltip>

          <Rule className="shrink-0" />

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="shrink-0">
                <TensionMeter value={state.rti} />
              </div>
            </TooltipTrigger>
            <TooltipContent>Real-Time Tension Index (RTI)</TooltipContent>
          </Tooltip>

          <Rule className="shrink-0" />

          {/* ── Transport status ───────────────────────────────────────────── */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex shrink-0 items-center gap-1.5 cursor-default"
                role="status"
                aria-live="polite"
              >
                <Dot tone={live ? "stable" : "neutral"} pulse={live} />
                <span className="text-2xs font-medium tracking-[0.06em] text-ink-3 uppercase whitespace-nowrap">
                  {state.bridge === "live"
                    ? "SD-RTN Connected"
                    : state.bridge === "connecting"
                      ? "Connecting"
                      : state.bridge === "closing"
                        ? "Closing"
                        : "Standby"}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent>Agora Real-Time Network & Voice Bridge Status</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setProjectModalOpen(true)}
                className="flex shrink-0 items-center gap-2 rounded-xs border border-line bg-sunken/60 px-2 py-1 text-2xs hover:bg-raised hover:border-line-strong transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-1 text-orange-400">
                  <span className="flex h-1.5 w-1.5 shrink-0 rounded-full bg-live" />
                  <span className="hidden font-mono text-[10px] xl:inline">Prom</span>
                </div>
                <span className="hidden text-ink-4 xl:inline">|</span>
                <div className="flex items-center gap-1 text-purple-400">
                  <span className="flex h-1.5 w-1.5 shrink-0 rounded-full bg-live" />
                  <span className="hidden font-mono text-[10px] xl:inline">DD</span>
                </div>
                <span className="hidden text-ink-4 xl:inline">|</span>
                <div className="flex items-center gap-1 text-cyan-400">
                  <span className="flex h-1.5 w-1.5 shrink-0 rounded-full bg-live" />
                  <span className="hidden font-mono text-[10px] xl:inline">CW</span>
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent>Observability Connectors (Prometheus, Datadog, CloudWatch) — Click to open Hub</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                icon={<Layers size={12} strokeWidth={2.2} className="text-live" />}
                onClick={() => setProjectModalOpen(true)}
              >
                <span className="hidden lg:inline">Workspace</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Manage Project Workspace, Team Roster & Connectors</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                icon={<Search size={12} strokeWidth={2.2} />}
                onClick={() => setHistoricalSearchOpen(true)}
              >
                <span className="hidden lg:inline">Precedents</span>
                <span className="hidden rounded border border-line bg-sunken px-1 py-0.5 text-3xs font-mono text-ink-4 xl:inline">
                  ⌘K
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search Cross-Incident Historical Postmortems (Ctrl+K)</TooltipContent>
          </Tooltip>

          <Rule className="shrink-0" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                icon={<FileText size={12} strokeWidth={2.2} />}
                onClick={() => setPostMortemOpen(true)}
              >
                <span className="hidden lg:inline">Post-Mortem</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Export Incident Post-Mortem & SOC2 Audit Report</TooltipContent>
          </Tooltip>

          <Rule className="shrink-0" />

          <div className="shrink-0">
            <UserMenu />
          </div>
        </div>
      </TooltipProvider>

      {/*
        Degradation banner — v6 §13's "demo-visible impact" column, made real.

        It sits in the command bar rather than a toast because a toast is
        dismissible and transient, and this is neither: while a dependency is
        down the operator must not forget it. The wording names the
        CONSEQUENCE ("Echo cannot speak") rather than the component, because
        "bridge controller unavailable" makes them guess.
      */}
      {state.degraded?.banner ? (
        <div
          role="status"
          className={cn(
            "absolute inset-x-0 top-full z-10 flex items-center justify-center gap-2",
            "border-b border-warning/35 bg-warning/12 py-1",
          )}
        >
          <Dot tone="warning" pulse />
          <span className="text-2xs font-semibold tracking-[0.08em] text-warning uppercase">
            {state.degraded.banner}
          </span>
        </div>
      ) : null}

      {/*
        OFF THE RECORD — §10.5.

        Takes precedence over the degradation banner's slot and is the single
        loudest thing on screen while it is up, because the failure mode it
        guards against is someone BELIEVING they are off the record when they
        are not — or, worse, believing they are on it when Echo has stopped
        minuting and nobody noticed the incident going unrecorded.

        Deliberately not dismissible, for the same reason the contradiction
        alert has no X: a state you can sweep away is a state people will
        forget they are in.

        This is one of the few places saturated colour is spent on something
        other than entity health, and it earns it — recording state IS status.
      */}
      {!state.privacy.recording ? (
        <div
          role="status"
          aria-live="assertive"
          className={cn(
            "absolute inset-x-0 top-full z-20 flex items-center justify-center gap-2",
            "border-b border-critical/45 bg-critical/15 py-1",
          )}
        >
          <MicOff size={11} strokeWidth={2.4} className="text-critical" />
          <span className="text-2xs font-semibold tracking-[0.08em] text-critical uppercase">
            Off the record — Echo has stopped minuting
          </span>
          {state.privacy.changedBy ? (
            <span className="text-2xs tracking-[0.04em] text-critical/70">
              (paused by {state.privacy.changedBy})
            </span>
          ) : null}
          {state.privacy.suspendedTurns > 0 ? (
            <span className="tnum font-mono text-2xs text-critical/70">
              {state.privacy.suspendedTurns} turn
              {state.privacy.suspendedTurns === 1 ? "" : "s"} not recorded
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Indeterminate progress hairline, pinned to the bar's bottom edge.
          Present only while the transport is actually negotiating. */}
      {state.bridge === "connecting" ? (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px overflow-hidden"
        >
          <span className="sweep block h-px w-1/3 bg-live" />
        </span>
      ) : null}
    </header>
  );
}
