"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * Modern shadcn-compatible Button primitive with Radix Slot integration.
 *
 * Adheres strictly to EchoSphere Rule 3: Saturated colour is reserved for status.
 * Primary buttons are rendered in high-contrast near-white on graphite.
 * Destructive/danger remains the one semantic exception.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,box-shadow] duration-150 ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40 select-none",
  {
    variants: {
      variant: {
        default:
          "bg-ink text-void hover:bg-white active:bg-ink-2 shadow-[inset_0_1px_0_0_oklch(1_0_0/40%)]",
        primary:
          "bg-ink text-void hover:bg-white active:bg-ink-2 shadow-[inset_0_1px_0_0_oklch(1_0_0/40%)]",
        secondary:
          "border border-line bg-overlay text-ink hover:bg-hover hover:border-line-strong active:bg-raised shadow-xs",
        destructive:
          "bg-critical/10 text-critical border border-critical/30 hover:bg-critical/20 hover:border-critical/50 active:bg-critical/30",
        danger:
          "bg-critical/10 text-critical border border-critical/30 hover:bg-critical/20 hover:border-critical/50 active:bg-critical/30",
        outline:
          "border border-line bg-transparent hover:bg-hover hover:text-ink text-ink-2",
        ghost:
          "bg-transparent text-ink-2 hover:bg-hover hover:text-ink border border-transparent",
        link:
          "text-ink underline-offset-4 hover:underline p-0 h-auto",
      },
      size: {
        default: "h-8 px-3 text-xs gap-1.5 rounded-sm",
        sm: "h-6 px-2 text-2xs gap-1 rounded-xs",
        md: "h-8 px-3 text-xs gap-1.5 rounded-sm",
        lg: "h-9 px-4 text-sm gap-2 rounded-sm",
        icon: "h-8 w-8 p-0 rounded-sm",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  icon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, icon, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        type={asChild ? undefined : "button"}
        {...props}
      >
        {icon && <span className="shrink-0">{icon}</span>}
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

/**
 * Keycap indicator for keyboard shortcuts.
 */
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-xs px-1",
        "border border-line bg-overlay font-mono text-[9px] leading-none text-ink-3",
        "shadow-[inset_0_-1px_0_0_oklch(0_0_0/40%)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export { Button, buttonVariants };
