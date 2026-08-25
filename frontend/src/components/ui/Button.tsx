"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Buttons.
 *
 * Note what is absent: there is no gradient, no glow, and no accent-coloured
 * primary. In an incident console the loudest pixel on screen has to be the
 * incident itself, so the primary action is rendered in near-white on graphite
 * — high contrast, zero chroma — and the saturated palette stays reserved for
 * status. `danger` is the one exception, because "leave the bridge" genuinely
 * is destructive and should look it.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-ink text-void hover:bg-white active:bg-ink-2 shadow-[inset_0_1px_0_0_oklch(1_0_0/40%)]",
  secondary:
    "surface text-ink hover:bg-hover hover:border-line-strong active:bg-overlay",
  ghost:
    "bg-transparent text-ink-2 hover:bg-hover hover:text-ink border border-transparent",
  danger:
    "bg-critical/10 text-critical border border-critical/30 hover:bg-critical/18 hover:border-critical/50 active:bg-critical/25",
};

const SIZES: Record<Size, string> = {
  sm: "h-6 px-2 text-2xs gap-1 rounded-xs",
  md: "h-8 px-3 text-xs gap-1.5 rounded-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium",
        "transition-[background-color,border-color,color] duration-150 ease-[var(--ease-out)]",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * A keycap. Every primary action in the console has one, because operators
 * under pressure reach for the keyboard and hunting for a button costs seconds
 * that matter.
 */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-xs px-1",
        "border border-line bg-overlay font-mono text-[9px] leading-none text-ink-3",
        "shadow-[inset_0_-1px_0_0_oklch(0_0_0/40%)]",
      )}
    >
      {children}
    </kbd>
  );
}
