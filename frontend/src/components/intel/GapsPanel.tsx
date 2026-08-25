"use client";

import { Crosshair } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { selectSupersededIds } from "@/lib/incident-reducer";
import { clockShort, initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Signal";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Unchecked items — what the conversation has NOT established (v6 §9.4).
 *
 * Requirement 5 asks for "detection of missing or conflicting information".
 * Conflicting is the loud half and everyone builds it; MISSING is the half that
 * usually stays an emergent hope. Here it is a first-class extraction output
 * with its own panel, because the strongest thing Echo does in the demo is not
 * spotting the contradiction — it is saying "the network path has not been
 * checked by anyone. Who owns that?"
 *
 * That sentence is only possible if the gap is a row in a table. A model asked
 * to notice absence on the fly will not do it reliably.
 *
 * Note what this panel deliberately does NOT do: it never proposes a cause. It
 * names the gap and suggests an owner, and stops there.
 */
export function GapsPanel() {
  const { state } = useIncident();
  const closed = selectSupersededIds(state);

  if (state.unchecked.length === 0) {
    return (
      <EmptyState
        icon={<Crosshair size={13} strokeWidth={2} />}
        title="No open gaps"
        hint="Things nobody on the bridge has established yet are listed here as Echo notices them."
      />
    );
  }

  // Covered gaps sink; the panel answers "what is still unknown".
  const ordered = [...state.unchecked].sort((a, b) => {
    const ac = closed.has(a.id) ? 1 : 0;
    const bc = closed.has(b.id) ? 1 : 0;
    return ac - bc || a.at - b.at;
  });

  return (
    <ul className="divide-y divide-line-faint">
      {ordered.map((u) => {
        const covered = closed.has(u.id);
        return (
          <li
            key={u.id}
            className={cn("enter-up flex gap-2.5 px-3 py-2.5", covered && "opacity-55")}
          >
            <span
              aria-hidden
              className={cn(
                "mt-px h-full w-[2px] shrink-0 rounded-full",
                covered ? "bg-stable/50" : "bg-warning/50",
              )}
            />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-xs leading-snug",
                  covered ? "text-ink-3 line-through" : "text-ink-2",
                )}
              >
                {u.description}
              </p>

              <div className="mt-1.5 flex items-center gap-2">
                {u.suggestedOwner ? (
                  <>
                    <span
                      aria-hidden
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border border-line bg-overlay font-mono text-[7px] font-semibold text-ink-3"
                    >
                      {initials(u.suggestedOwner)}
                    </span>
                    <span className="text-[9px] text-ink-4">
                      suggested: {u.suggestedOwner}
                    </span>
                  </>
                ) : (
                  <span className="text-[9px] text-ink-4">unowned</span>
                )}

                <Badge
                  tone={covered ? "stable" : "warning"}
                  variant="outline"
                  className="ml-auto"
                >
                  {covered ? "Covered" : "Unchecked"}
                </Badge>

                <span className="tnum font-mono text-[9px] text-ink-4">
                  {clockShort(u.at)}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
