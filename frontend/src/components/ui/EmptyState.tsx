import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Empty states.
 *
 * An empty pane in an operations console is not a gap to apologise for — it is
 * a status report: *nothing has been extracted here yet*. So these are written
 * as statements of fact, in the same register as the rest of the interface. No
 * italics, no ellipses trailing off, no illustration, no exclamation.
 *
 * The `hint` line tells the operator what will appear here and what triggers
 * it, which turns dead space into an explanation of how the system works.
 */
export function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? (
        <span className="mb-1 flex h-7 w-7 items-center justify-center rounded-sm border border-line-faint bg-sunken text-ink-4">
          {icon}
        </span>
      ) : null}
      <p className="text-xs font-medium text-ink-3">{title}</p>
      {hint ? (
        <p className="max-w-[24ch] text-2xs leading-relaxed text-ink-4">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
