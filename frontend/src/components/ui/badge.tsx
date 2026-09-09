import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-xs px-1.5 py-0.5 text-[10px] font-medium font-mono transition-colors focus:outline-hidden",
  {
    variants: {
      variant: {
        default: "border border-line bg-raised text-ink",
        secondary: "border border-line-faint bg-overlay text-ink-2 hover:bg-hover",
        destructive: "border border-critical/40 bg-critical/15 text-critical",
        outline: "border border-line text-ink-3",
        // Semantic incident status variants
        critical: "border border-critical/40 bg-critical/15 text-critical font-semibold",
        warning: "border border-warning/40 bg-warning/15 text-warning font-semibold",
        stable: "border border-stable/40 bg-stable/15 text-stable font-semibold",
        live: "border border-live/40 bg-live/15 text-live font-semibold",
        neutral: "border border-line bg-sunken text-ink-3",
        soft: "border border-line-faint bg-raised/70 text-ink-2",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

