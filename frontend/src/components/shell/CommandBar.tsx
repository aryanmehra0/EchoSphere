"use client";

import { MicOff, Radio } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import {
  selectOpenContradictions,
  selectOpenTasks,
} from "@/lib/incident-reducer";
import { elapsed } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Dot, Metric, Rule } from "@/components/ui/Signal";
import { TensionMeter } from "@/components/ui/Meter";
import { UserMenu } from "@/components/shell/UserMenu";
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
  const { state, now } = useIncident();
  const openContradictions = selectOpenContradictions(state);
  const openTasks = selectOpenTasks(state);

  const live = state.bridge === "live";

  return (
    <header
      className={cn(
        "relative z-20 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-raised px-4",
        "shadow-[inset_0_1px_0_0_oklch(1_0_0/4%)]",
      )}
    >
      {/* ── Identity ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5">
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
          </div>
          <span className="font-mono text-2xs leading-none text-ink-4">
            {state.id}
          </span>
        </div>
      </div>

      <Rule />

      {/* ── Headline ──────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="truncate text-xs leading-none font-medium text-ink-2">
          {state.title}
        </h1>
        <PhaseTrack phase={state.phase} />
      </div>

      {/* Everything past here is right-aligned instrumentation. */}
      <div className="ml-auto flex items-center gap-4">
        <Metric
          label="Elapsed"
          value={elapsed(state.startedAt, now)}
          title="Time since the incident bridge opened"
        />

        <Rule />

        <Metric
          label="Conflicts"
          value={openContradictions.length.toString().padStart(2, "0")}
          tone={openContradictions.length > 0 ? "warning" : "neutral"}
          title="Unresolved contradictions detected by the semantic engine"
        />
        {/* Requirement 5 has two halves. Conflicts is the loud one; Gaps is
            what nobody has checked, and it belongs beside it at the top level
            rather than buried a tab deep. */}
        <Metric
          label="Gaps"
          value={state.unchecked.length.toString().padStart(2, "0")}
          tone={state.unchecked.length > 0 ? "warning" : "neutral"}
          title="Things nobody on the bridge has established yet"
        />
        <Metric
          label="Open"
          value={openTasks.length.toString().padStart(2, "0")}
          tone={openTasks.length > 0 ? "live" : "neutral"}
          title="Action items not yet closed"
        />

        <Rule />

        <TensionMeter value={state.rti} />

        <Rule />

        {/* ── Transport status ───────────────────────────────────────────── */}
        <div
          className="flex items-center gap-1.5"
          role="status"
          aria-live="polite"
        >
          <Dot tone={live ? "stable" : "neutral"} pulse={live} />
          <span className="text-2xs font-medium tracking-[0.06em] text-ink-3 uppercase">
            {state.bridge === "live"
              ? "SD-RTN Connected"
              : state.bridge === "connecting"
                ? "Connecting"
                : state.bridge === "closing"
                  ? "Closing"
                  : "Standby"}
          </span>
        </div>

        <Rule />

        <UserMenu />
      </div>

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
