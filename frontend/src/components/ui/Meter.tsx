import { cn } from "@/lib/cn";
import type { Tone } from "./Signal";

/**
 * Segmented LED meter — the Room Tension Index readout (master doc §7.2).
 *
 * Discrete segments rather than a smooth fill, for a reason that is functional
 * rather than stylistic: a continuous bar invites the operator to read a
 * precise value off a quantity that is a heuristic. Segments say "this is a
 * band, not a measurement", which is honest about what RTI actually is.
 *
 * The value is computed server-side from `vad_result_state`; this component
 * only renders it.
 */

const SEGMENTS = 14;

/** Bands are ordered loudest-first so the first match wins. */
function toneFor(value: number): Tone {
  if (value >= 0.75) return "critical";
  if (value >= 0.5) return "warning";
  if (value >= 0.2) return "live";
  return "stable";
}

const LIT: Record<Tone, string> = {
  critical: "bg-critical",
  warning: "bg-warning",
  stable: "bg-stable",
  live: "bg-live",
  neutral: "bg-ink-4",
};

export function TensionMeter({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const tone = toneFor(value);
  const lit = Math.round(value * SEGMENTS);

  return (
    <div
      className={cn("flex flex-col gap-1", className)}
      role="meter"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Room tension index"
    >
      <div className="flex items-end gap-[2px]" aria-hidden>
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const on = i < lit;
          return (
            <span
              key={i}
              className={cn(
                "w-[3px] rounded-[1px] transition-[background-color,height] duration-300 ease-[var(--ease-out)]",
                on ? LIT[tone] : "bg-line",
                // Segments rise toward the right so the meter reads as a ramp
                // even at a glance, before the colour registers.
                i < 5 ? "h-2" : i < 10 ? "h-2.5" : "h-3",
                // Only the leading segment breathes, and only when it matters.
                on && i === lit - 1 && value >= 0.75 && "beacon",
              )}
            />
          );
        })}
      </div>
      <span className="text-2xs leading-none font-medium tracking-[0.08em] text-ink-4 uppercase">
        Tension
      </span>
    </div>
  );
}
