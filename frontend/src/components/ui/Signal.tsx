import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { EntityStatus, TaskStatus } from "@/lib/types";

/**
 * Status vocabulary.
 *
 * Colour here is information, not styling. Two rules govern this file:
 *
 *   1. A status is NEVER communicated by colour alone. Every dot carries a
 *      text label or an accessible name; every badge carries a word. This is
 *      both a WCAG 1.4.1 requirement and simple operational sense — roughly 1
 *      in 12 men cannot separate our red from our green, and this console gets
 *      projected onto whatever the conference room happens to have.
 *   2. These four hues appear nowhere else in the interface. The moment a
 *      button or a heading borrows `critical` for emphasis, the operator stops
 *      trusting red to mean "something is broken".
 */

/* -------------------------------------------------------------------------- */
/* Tone → token mapping                                                        */
/* -------------------------------------------------------------------------- */

export type Tone = "critical" | "warning" | "stable" | "live" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  critical: "text-critical",
  warning: "text-warning",
  stable: "text-stable",
  live: "text-live",
  neutral: "text-ink-3",
};

const TONE_BG: Record<Tone, string> = {
  critical: "bg-critical",
  warning: "bg-warning",
  stable: "bg-stable",
  live: "bg-live",
  neutral: "bg-ink-4",
};

const TONE_SOFT: Record<Tone, string> = {
  critical: "bg-critical/12 text-critical border-critical/25",
  warning: "bg-warning/12 text-warning border-warning/25",
  stable: "bg-stable/12 text-stable border-stable/25",
  live: "bg-live/12 text-live border-live/25",
  neutral: "bg-ink-4/12 text-ink-2 border-line",
};

export const statusTone: Record<EntityStatus, Tone> = {
  CRITICAL: "critical",
  WARNING: "warning",
  OK: "stable",
  UNKNOWN: "neutral",
};

export const taskTone: Record<TaskStatus, Tone> = {
  OPEN: "warning",
  IN_PROGRESS: "live",
  BLOCKED: "critical",
  DONE: "stable",
};

/* -------------------------------------------------------------------------- */
/* Dot                                                                         */
/* -------------------------------------------------------------------------- */

interface DotProps {
  tone: Tone;
  /** Adds the expanding halo. Reserved for genuinely live/changing state. */
  pulse?: boolean;
  /** Accessible name. Required whenever the dot is not adjacent to a label. */
  label?: string;
  className?: string;
}

export function Dot({ tone, pulse = false, label, className }: DotProps) {
  return (
    <span
      className={cn("relative inline-flex h-1.5 w-1.5 shrink-0", className)}
      role={label ? "img" : "presentation"}
      aria-label={label}
    >
      {pulse ? (
        <span
          className={cn(
            "halo absolute inset-0 rounded-full",
            TONE_BG[tone],
          )}
          aria-hidden
        />
      ) : null}
      <span
        className={cn("relative h-1.5 w-1.5 rounded-full", TONE_BG[tone])}
        aria-hidden
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                       */
/* -------------------------------------------------------------------------- */

interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  /** `solid` is reserved for severity — the loudest thing on screen. */
  variant?: "soft" | "outline" | "solid";
  mono?: boolean;
  className?: string;
}

export function Badge({
  children,
  tone = "neutral",
  variant = "soft",
  mono = false,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-xs border px-1.5 py-px text-2xs font-semibold uppercase tracking-[0.07em] whitespace-nowrap",
        mono && "font-mono tracking-normal normal-case",
        variant === "soft" && TONE_SOFT[tone],
        variant === "outline" &&
          cn("border-line bg-transparent", TONE_TEXT[tone]),
        variant === "solid" &&
          cn(TONE_BG[tone], "border-transparent text-void"),
        className,
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Metric                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A labelled readout for the command bar. The value sits above the label at a
 * larger optical weight, so the bar can be scanned by value alone at distance
 * and the labels only resolve when you lean in.
 */
export function Metric({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-px" title={title}>
      <span
        className={cn(
          "tnum font-mono text-sm leading-none font-medium whitespace-nowrap",
          TONE_TEXT[tone],
        )}
      >
        {value}
      </span>
      <span className="text-2xs leading-none font-medium tracking-[0.08em] text-ink-4 uppercase whitespace-nowrap">
        {label}
      </span>
    </div>
  );
}

/** Vertical hairline separator for the command bar and status bar. */
export function Rule({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("h-6 w-px shrink-0 bg-line-faint", className)}
    />
  );
}
