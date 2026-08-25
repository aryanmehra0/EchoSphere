"use client";

import { useEffect, useRef, useState } from "react";
import { Layers } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Dot } from "@/components/ui/Signal";

/**
 * Graph legend.
 *
 * A legend is not optional documentation here — the canvas encodes meaning in
 * four colours and two line styles, and a judge or a new engineer arriving
 * mid-incident has no way to decode "dashed amber" without being told. It is
 * collapsed by default so it costs nothing once you know the system, and it
 * closes on Escape and on outside click like any other transient surface.
 */

const STATUS = [
  { tone: "critical" as const, label: "Confirmed failure" },
  { tone: "warning" as const, label: "Contested / at risk" },
  { tone: "stable" as const, label: "Healthy or resolved" },
  { tone: "neutral" as const, label: "Not yet assessed" },
];

export function GraphLegend() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Graph legend"
        title="Graph legend"
        className={cn("h-6 gap-1 px-1.5", open && "border-line-strong bg-hover")}
        icon={<Layers size={11} strokeWidth={2.2} />}
      >
        <span className="text-2xs">Legend</span>
      </Button>

      {open ? (
        <div
          className={cn(
            "enter-up absolute top-7 right-0 z-30 w-56 rounded-md border border-line-strong bg-overlay p-3",
            "shadow-[0_8px_28px_-8px_oklch(0_0_0/70%)]",
          )}
        >
          <p className="eyebrow mb-2">Entity status</p>
          <ul className="mb-3 space-y-1.5">
            {STATUS.map((s) => (
              <li key={s.label} className="flex items-center gap-2">
                <Dot tone={s.tone} />
                <span className="text-2xs text-ink-2">{s.label}</span>
              </li>
            ))}
          </ul>

          <p className="eyebrow mb-2">Link type</p>
          <ul className="space-y-1.5">
            <li className="flex items-center gap-2">
              <svg width="18" height="6" aria-hidden className="shrink-0">
                <line
                  x1="0"
                  y1="3"
                  x2="18"
                  y2="3"
                  stroke="var(--color-ink-2)"
                  strokeWidth="1.6"
                />
              </svg>
              <span className="text-2xs text-ink-2">Confirmed causal</span>
            </li>
            <li className="flex items-center gap-2">
              <svg width="18" height="6" aria-hidden className="shrink-0">
                <line
                  x1="0"
                  y1="3"
                  x2="18"
                  y2="3"
                  stroke="var(--color-warning)"
                  strokeWidth="1.4"
                  strokeDasharray="4 3"
                />
              </svg>
              <span className="text-2xs text-ink-2">Suspected — unverified</span>
            </li>
          </ul>

          <p className="mt-3 border-t border-line-faint pt-2 text-[10px] leading-relaxed text-ink-4">
            Echo plots only what participants stated. It does not infer a root
            cause independently.
          </p>
        </div>
      ) : null}
    </div>
  );
}
