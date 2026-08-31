"use client";

import { Scale, Users } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import {
  selectClaimsByIds,
  selectOpenContradictions,
} from "@/lib/incident-reducer";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Signal";
import { Button } from "@/components/ui/Button";
import { clockShort, initials } from "@/lib/format";
import type { PanelDeliberation } from "@/lib/types";

/**
 * The contradiction alert.
 *
 * This is the single most important thing the product does, so it is the only
 * element permitted to overlay the graph. It docks to the bottom of the canvas
 * rather than living in a side panel, because a contradiction is a statement
 * ABOUT the graph and belongs adjacent to it.
 *
 * The two claims are set side by side with equal visual weight and a "vs"
 * divider. That symmetry is deliberate and load-bearing: Echo's job is to
 * surface the conflict for humans to adjudicate, not to pick a winner. The
 * moment one claim is styled as correct, the tool has quietly started
 * determining root cause on its own — exactly what the problem statement
 * forbids.
 *
 * Dismissal is therefore "Mark resolved" performed by a person, never
 * automatic.
 */

function Claim({
  text,
  speaker,
  at,
  align,
}: {
  text: string;
  speaker: string;
  /** When the claim was made. Rule 1 attribution is source AND time. */
  at?: number;
  align: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1.5",
        align === "right" && "items-end text-right",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5",
          align === "right" && "flex-row-reverse",
        )}
      >
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border border-warning/30 bg-warning/10 font-mono text-[8px] font-semibold text-warning"
        >
          {initials(speaker)}
        </span>
        <span className="text-[10px] font-semibold tracking-[0.05em] text-warning uppercase">
          {speaker}
        </span>
        {at ? (
          <span className="tnum font-mono text-[9px] text-warning/60">
            {clockShort(at)}
          </span>
        ) : null}
      </div>
      <p className="text-xs leading-snug text-ink-2">{text}</p>
    </div>
  );
}

/**
 * How the Deliberation Panel reached this verdict — §7a.
 *
 * ── WHY THIS IS ON SCREEN AT ALL ───────────────────────────────────────────
 * Stage 3 used to be one model against one prompt, and that prompt leaned
 * away from OPPOSED to suppress false alarms. It over-corrected: a live
 * rehearsal fed "the cache is fine" against "cache read timeouts" and the
 * judge returned INDEPENDENT, so the room heard nothing. Two analysts with
 * opposite biases now read every pair, and a third settles any split.
 *
 * Showing the split is the point, not a debug affordance. A conflict the
 * analysts DISAGREED about is a weaker thing to act on than a unanimous one,
 * and an operator deserves to know which they are looking at. Presenting a
 * contested verdict as settled would be the same error as filing a
 * HYPOTHESIS as OBSERVED — Echo overstating its own certainty, one level up.
 *
 * ── WHY IT IS DELIBERATELY DRAB ────────────────────────────────────────────
 * The claims above are the finding; this is Echo's working. Saturated colour
 * is reserved for status, and the alert already spends warning on the
 * conflict itself. So the rail sits in graphite, and only DISSENT — which is
 * genuinely a status — is allowed to carry any.
 * ───────────────────────────────────────────────────────────────────────────
 */
function PanelRail({ panel }: { panel: PanelDeliberation }) {
  // The referee only sits when the bench splits, so its presence IS the signal.
  const bench = panel.positions.filter((p) => p.persona !== "REFEREE");
  const referee = panel.positions.find((p) => p.persona === "REFEREE");

  return (
    <div className="border-t border-line-faint bg-sunken/40 px-4 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Users size={10} strokeWidth={2.2} className="text-ink-4" />
        <span className="text-[9px] font-semibold tracking-[0.08em] text-ink-4 uppercase">
          Deliberation
        </span>
        {panel.dissent ? (
          <Badge tone="warning" variant="outline">
            Analysts split
          </Badge>
        ) : (
          <span className="text-[9px] tracking-[0.04em] text-ink-4 uppercase">
            Unanimous
          </span>
        )}
        <span className="tnum ml-auto font-mono text-[9px] text-ink-4">
          {Math.round(panel.confidence * 100)}% confidence
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {bench.map((p) => (
          <li key={p.persona} className="flex items-baseline gap-2 text-[10px]">
            <span className="w-14 shrink-0 font-mono font-semibold tracking-[0.04em] text-ink-3 uppercase">
              {p.persona}
            </span>
            <span className="w-[5.5rem] shrink-0 font-mono text-[9px] text-ink-2">
              {p.relation}
            </span>
            <span className="tnum w-8 shrink-0 font-mono text-[9px] text-ink-4">
              {p.confidence.toFixed(2)}
            </span>
            {/* The model is shown because persona independence IS model
                independence — same model twice would be one opinion. */}
            <span className="min-w-0 flex-1 truncate text-ink-4" title={p.why}>
              {p.why || <span className="italic text-ink-4">no reason given</span>}
            </span>
            <span className="hidden shrink-0 font-mono text-[8px] text-ink-4/70 md:inline">
              {p.model}
            </span>
          </li>
        ))}
      </ul>

      {referee ? (
        <div className="mt-2 border-l-2 border-warning/30 pl-2">
          <p className="text-[10px] leading-snug text-ink-3">
            <span className="font-mono font-semibold tracking-[0.04em] text-ink-2 uppercase">
              Referee
            </span>{" "}
            ruled <span className="font-mono text-ink-2">{referee.relation}</span>
            {referee.why ? <> — {referee.why}</> : null}
          </p>
          {panel.whyOtherFailed ? (
            <p className="mt-0.5 text-[10px] leading-snug text-ink-4">
              What the other analyst missed: {panel.whyOtherFailed}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ContradictionAlert() {
  const { state, dispatch } = useIncident();
  const open = selectOpenContradictions(state);

  // Only the most recent unresolved conflict is shown. Stacking alerts over a
  // live graph would hide the thing they are describing; the rest are counted.
  const current = open[open.length - 1];

  // v6 §9.2 sends claim REFERENCES, not copies, so the Ledger stays the single
  // source of truth for a claim's text and attribution. Resolve them here.
  const [claimA, claimB] = selectClaimsByIds(state, [
    current?.claimA ?? "",
    current?.claimB ?? "",
  ]);

  if (!current) return null;

  return (
    <div
      role="alert"
      className={cn(
        "enter-up pointer-events-auto w-full max-w-[680px] overflow-hidden rounded-md",
        "border border-warning/40 bg-raised",
        "shadow-[0_0_0_1px_oklch(0_0_0/30%),0_14px_40px_-12px_oklch(0_0_0/80%)]",
      )}
    >
      {/* Header rail */}
      <div className="flex items-center gap-2 border-b border-warning/25 bg-warning/10 px-3 py-1.5">
        <Scale size={12} strokeWidth={2.2} className="text-warning" />
        <span className="text-2xs font-semibold tracking-[0.08em] text-warning uppercase">
          Contradiction detected
        </span>
        <Badge tone="warning" variant="outline" className="ml-1">
          Semantic engine
        </Badge>

        {/*
          There is deliberately no dismiss affordance here.

          An X would let an operator sweep a conflict off the screen without
          anyone ruling on it, which is precisely the failure this feature
          exists to prevent — and it would be indistinguishable, in the audit
          log, from a resolution. The only way out of this alert is the
          explicit "Mark resolved" below, performed by a person.
        */}
        {open.length > 1 ? (
          <span className="tnum ml-auto font-mono text-2xs text-warning/70">
            +{open.length - 1} more
          </span>
        ) : null}
      </div>

      {/* Claims, weighted equally */}
      <div className="flex items-start gap-3 px-4 py-3">
        <Claim
          text={claimA?.text ?? "Claim not found in ledger"}
          speaker={claimA?.speakerRole ?? current.speakers[0] ?? "Unknown"}
          at={claimA?.at}
          align="left"
        />

        <div className="flex shrink-0 flex-col items-center gap-1 self-stretch pt-1">
          <span className="h-full w-px bg-warning/20" aria-hidden />
          <span className="rounded-xs border border-warning/30 bg-raised px-1 font-mono text-[9px] font-semibold text-warning">
            VS
          </span>
          <span className="h-full w-px bg-warning/20" aria-hidden />
        </div>

        <Claim
          text={claimB?.text ?? "Claim not found in ledger"}
          speaker={claimB?.speakerRole ?? current.speakers[1] ?? "Unknown"}
          at={claimB?.at}
          align="right"
        />
      </div>

      {/* Echo's working, shown rather than hidden. Absent for verdicts that
          came from the pre-panel single judge, and for the scripted replay. */}
      {current.panel ? <PanelRail panel={current.panel} /> : null}

      {/* Resolution rail — the human-in-the-loop gate. */}
      <div className="flex items-center justify-between gap-3 border-t border-line-faint bg-sunken/60 px-3 py-1.5">
        <p className="text-[10px] leading-snug text-ink-4">
          Echo has surfaced the conflict. Adjudication is the team&rsquo;s call.
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            dispatch({ type: "RESOLVE_CONTRADICTION", id: current.id })
          }
        >
          Mark resolved
        </Button>
      </div>
    </div>
  );
}
