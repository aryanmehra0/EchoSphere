"use client";

import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock3,
  Scale,
  Split,
  type LucideIcon,
} from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { clock } from "@/lib/format";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import type { TimelineKind } from "@/lib/types";
import type { Tone } from "@/components/ui/Signal";

/**
 * The incident timeline.
 *
 * Rendered as a true vertical rail with markers rather than a list of rows,
 * because the timeline is the artefact that becomes the post-mortem and people
 * read it as a narrative — the eye needs a spine to follow.
 *
 * Event kind is encoded by glyph first and colour second. That ordering is
 * deliberate: this panel gets screenshotted into incident reports that are
 * printed, pasted into Slack in light mode, and read by people who cannot
 * separate the hues, so the shape has to survive on its own.
 */

const KIND: Record<TimelineKind, { icon: LucideIcon; tone: Tone; label: string }> =
  {
    signal: { icon: CircleDot, tone: "live", label: "Signal" },
    decision: { icon: Split, tone: "stable", label: "Decision" },
    action: { icon: CircleAlert, tone: "warning", label: "Action" },
    contradiction: { icon: Scale, tone: "warning", label: "Conflict" },
    resolution: { icon: CircleCheck, tone: "stable", label: "Resolution" },
  };

const MARKER: Record<Tone, string> = {
  critical: "border-critical/50 bg-critical/12 text-critical",
  warning: "border-warning/45 bg-warning/12 text-warning",
  stable: "border-stable/45 bg-stable/12 text-stable",
  live: "border-live/45 bg-live/12 text-live",
  neutral: "border-line bg-overlay text-ink-3",
};

export function TimelinePanel() {
  const { state } = useIncident();

  if (state.timeline.length === 0) {
    return (
      <EmptyState
        icon={<Clock3 size={13} strokeWidth={2} />}
        title="Timeline empty"
        hint="Signals, decisions and actions are stamped here in the order they occur."
      />
    );
  }

  return (
    <ol className="relative px-3 py-3">
      {/* The spine. Inset to pass through the centre of each marker. */}
      <span
        aria-hidden
        className="absolute top-4 bottom-4 left-[21px] w-px bg-line"
      />

      {state.timeline.map((e) => {
        // Same hazard as EntityNode: an unknown kind yields undefined and
        // `meta.icon` throws, blanking the whole console.
        const meta = KIND[e.kind] ?? KIND.signal;
        const Icon = meta.icon;

        return (
          <li key={e.id} className="enter-up relative flex gap-3 pb-4 last:pb-0">
            <span
              aria-hidden
              className={cn(
                "relative z-10 mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border",
                MARKER[meta.tone] ?? MARKER.neutral,
              )}
            >
              <Icon size={9} strokeWidth={2.4} />
            </span>

            <div className="min-w-0 flex-1 pt-px">
              <div className="mb-0.5 flex items-baseline gap-2">
                <span className="tnum font-mono text-[9px] font-medium text-ink-3">
                  {clock(e.at)}
                </span>
                <span className="text-[9px] tracking-[0.07em] text-ink-4 uppercase">
                  {meta.label}
                </span>
                <span className="ml-auto truncate text-[9px] text-ink-4">
                  {e.actor}
                </span>
              </div>
              <p className="text-xs leading-snug text-ink-2">{e.text}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
