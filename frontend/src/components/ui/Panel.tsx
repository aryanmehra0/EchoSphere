import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The console's only container.
 *
 * Every region of the interface is a Panel. Enforcing one container primitive
 * is what keeps a dense multi-pane layout from drifting — there is exactly one
 * header height, one rule weight and one padding rhythm, and no component gets
 * to negotiate its own.
 */

interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Panels default to a flush pane; `inset` gives the raised card treatment. */
  inset?: boolean;
}

export function Panel({ children, className, inset = false }: PanelProps) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col",
        inset && "surface rounded-md",
        className,
      )}
    >
      {children}
    </section>
  );
}

interface PanelHeaderProps {
  title: string;
  icon?: ReactNode;
  /** Right-aligned slot: counts, toggles, status. Kept visually secondary. */
  aside?: ReactNode;
  className?: string;
}

/**
 * Fixed at 34px. Panel headers must align across all three columns — a 2px
 * discrepancy between neighbouring panes is the single most common tell of an
 * interface that was assembled rather than designed.
 */
export function PanelHeader({
  title,
  icon,
  aside,
  className,
}: PanelHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-[34px] shrink-0 items-center justify-between gap-2 border-b border-line-faint px-3",
        className,
      )}
    >
      <h2 className="eyebrow flex items-center gap-1.5">
        {icon ? <span className="text-ink-4">{icon}</span> : null}
        {title}
      </h2>
      {aside ? <div className="flex items-center gap-1.5">{aside}</div> : null}
    </header>
  );
}

/**
 * Scrollable body for a panel. Owns the scrollbar styling and the `min-h-0`
 * that stops a flex child from refusing to shrink — the single most common
 * cause of a "why won't this pane scroll" bug in a full-height layout.
 *
 * Extra props are forwarded so a body can also serve as a `tabpanel`.
 */
export function PanelBody({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("scroll-thin min-h-0 flex-1 overflow-y-auto", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
