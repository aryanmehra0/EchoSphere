"use client";

import { CircleCheck, FlaskConical, Sparkles, Wrench } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import {
  selectEstablished,
  selectHypotheses,
  selectInferences,
  selectSupersededIds,
} from "@/lib/incident-reducer";
import { clockShort, initials, pct } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Signal";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Claim } from "@/lib/types";

/**
 * The Evidence Ledger — v6 §6.
 *
 * This panel is the direct answer to the problem statement's hardest clause:
 * organise the discussion "without pretending to independently determine the
 * root cause". So the separation is STRUCTURAL — three headed sections over one
 * claim table, discriminated by `epistemicStatus` — not a filter or a tag. A
 * status pill on a flat list is easy to overlook at 2am, and an assumption read
 * as a fact is how incidents get made worse.
 *
 *   ESTABLISHED   OBSERVED + TOOL_RESULT. Echo may say these, with attribution.
 *   OPEN QUESTIONS  HYPOTHESIS. Echo may raise these only interrogatively.
 *   ECHO'S INFERENCES  INFERRED. Dashed, badged, and NEVER spoken (Rule 3).
 *
 * The third section is the one that wins the argument with a judge. Most
 * entries would quietly promote a model's inference into a fact; here it is
 * visually quarantined and labelled as never reaching the voice channel.
 */

function SectionHead({
  icon,
  title,
  count,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line-faint bg-base/95 px-3 py-1.5 backdrop-blur-[2px]">
      <span className="text-ink-4">{icon}</span>
      <span className="eyebrow">{title}</span>
      <span className="tnum font-mono text-2xs text-ink-4">
        {count.toString().padStart(2, "0")}
      </span>
      <span className="ml-auto text-[9px] text-ink-4">{hint}</span>
    </div>
  );
}

function Attribution({ claim }: { claim: Claim }) {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span
        aria-hidden
        className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border border-line bg-overlay font-mono text-[7px] font-semibold text-ink-3"
      >
        {initials(claim.speakerRole)}
      </span>
      <span className="text-[9px] text-ink-4">{claim.speakerRole}</span>
      {claim.lifecycle === "STALE" && (
        <span
          className="rounded-[2px] border border-warning/40 bg-warning/15 px-1 font-mono text-[8px] font-semibold text-warning"
          title="Telemetry TTL expired without renewal"
        >
          STALE
        </span>
      )}
      <span className="tnum ml-auto font-mono text-[9px] text-ink-4">
        {clockShort(claim.at)}
      </span>
      <span
        className={cn(
          "tnum font-mono text-[9px] font-medium",
          claim.confidence >= 0.95
            ? "text-stable"
            : claim.confidence >= 0.8
              ? "text-ink-2"
              : "text-warning",
        )}
        title={`Extraction confidence: ${pct(claim.confidence)}`}
      >
        {pct(claim.confidence)}
      </span>
    </div>
  );
}

export function LedgerPanel() {
  const { state, selectedEntityId, setSelectedEntityId } = useIncident();

  const selectedEntity = selectedEntityId
    ? state.entities.find((e) => e.id === selectedEntityId)
    : null;

  const rawEstablished = selectEstablished(state);
  const rawHypotheses = selectHypotheses(state);
  const rawInferences = selectInferences(state);
  const settled = selectSupersededIds(state);

  const filterClaims = (list: Claim[]) =>
    selectedEntityId ? list.filter((c) => c.entity === selectedEntityId) : list;

  const established = filterClaims(rawEstablished);
  const hypotheses = filterClaims(rawHypotheses);
  const inferences = filterClaims(rawInferences);

  if (state.claims.length === 0) {
    return (
      <EmptyState
        icon={<CircleCheck size={13} strokeWidth={2} />}
        title="Ledger empty"
        hint="Claims are recorded with a source and an epistemic status as they are spoken."
      />
    );
  }

  return (
    <div>
      {/* ── Entity Cross-Filter Pill Banner ─────────────────────────────── */}
      {selectedEntity && (
        <div className="flex items-center justify-between border-b border-line bg-sunken/80 px-3 py-1.5 text-2xs">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono uppercase tracking-wider text-[9px] text-ink-4">Filtered:</span>
            <span className="truncate font-semibold text-ink">{selectedEntity.label}</span>
            <span className="font-mono text-ink-4 text-[9px]">
              ({established.length + hypotheses.length + inferences.length} claims)
            </span>
          </div>
          <button
            onClick={() => setSelectedEntityId(null)}
            className="ml-2 font-mono text-[9px] text-ink-3 hover:text-ink underline cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Established ──────────────────────────────────────────────────── */}
      <SectionHead
        icon={<CircleCheck size={11} strokeWidth={2.2} />}
        title="Established"
        count={established.length}
        hint="measured or returned"
      />

      {established.length === 0 ? (
        <p className="px-3 py-3 text-2xs text-ink-4">Nothing established yet.</p>
      ) : (
        <ul className="divide-y divide-line-faint">
          {established.map((c) => (
            <li key={c.id} className="enter-up flex gap-2.5 px-3 py-2.5">
              <span
                aria-hidden
                className="mt-px h-full w-[2px] shrink-0 rounded-full bg-stable/50"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-snug text-ink-2">{c.text}</p>
                <Attribution claim={c} />
              </div>
              {/* A tool result is evidence of a different kind from a human
                  measurement, and the close-out has to distinguish them. */}
              {c.epistemicStatus === "TOOL_RESULT" ? (
                <Wrench
                  size={10}
                  strokeWidth={2.2}
                  className="mt-0.5 shrink-0 text-ink-4"
                  aria-label="Tool result"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* ── Open questions ───────────────────────────────────────────────── */}
      <SectionHead
        icon={<FlaskConical size={11} strokeWidth={2.2} />}
        title="Open questions"
        count={hypotheses.length}
        hint="proposed, unconfirmed"
      />

      {hypotheses.length === 0 ? (
        <p className="px-3 py-3 text-2xs text-ink-4">No open questions.</p>
      ) : (
        <ul className="divide-y divide-line-faint">
          {hypotheses.map((c) => {
            const closed = settled.has(c.id);
            return (
              <li
                key={c.id}
                className={cn(
                  "enter-up flex gap-2.5 px-3 py-2.5",
                  closed && "opacity-55",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-px h-full w-[2px] shrink-0 rounded-full",
                    closed ? "bg-stable/50" : "bg-warning/50",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-xs leading-snug",
                      closed ? "text-ink-3 line-through" : "text-ink-2",
                    )}
                  >
                    {c.text}
                  </p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span
                      aria-hidden
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border border-line bg-overlay font-mono text-[7px] font-semibold text-ink-3"
                    >
                      {initials(c.speakerRole)}
                    </span>
                    <span className="text-[9px] text-ink-4">{c.speakerRole}</span>
                    <Badge
                      tone={closed ? "stable" : "warning"}
                      variant="outline"
                      className="ml-auto"
                    >
                      {closed ? "Settled" : "Open"}
                    </Badge>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Echo's inferences ────────────────────────────────────────────── */}
      {inferences.length > 0 ? (
        <>
          <SectionHead
            icon={<Sparkles size={11} strokeWidth={2.2} />}
            title="Echo's inferences"
            count={inferences.length}
            hint="never spoken"
          />
          <ul className="space-y-2 px-3 py-2.5">
            {inferences.map((c) => (
              <li
                key={c.id}
                className={cn(
                  "enter-up rounded-sm border border-dashed border-line-strong bg-sunken/40 px-2.5 py-2",
                )}
              >
                <p className="text-xs leading-snug text-ink-3 italic">{c.text}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge tone="neutral" variant="outline">
                    Inferred
                  </Badge>
                  <span className="text-[9px] text-ink-4">
                    dashboard only — filtered from the voice channel
                  </span>
                  <span className="tnum ml-auto font-mono text-[9px] text-ink-4">
                    {pct(c.confidence)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
