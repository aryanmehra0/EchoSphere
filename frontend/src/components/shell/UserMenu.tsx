"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/cn";
import type { ParticipantRole } from "@/lib/types";

function getRoleBadge(role: ParticipantRole) {
  switch (role) {
    case "Incident Commander":
      return { label: "IC", className: "border-live/40 bg-live/15 text-live font-semibold" };
    case "DevOps Lead":
      return { label: "DevOps", className: "border-cyan-500/40 bg-cyan-500/15 text-cyan-400 font-medium" };
    case "Site Reliability Engineer":
      return { label: "SRE", className: "border-blue-500/40 bg-blue-500/15 text-blue-400 font-medium" };
    case "Database Admin":
      return { label: "DBA", className: "border-amber-500/40 bg-amber-500/15 text-amber-400 font-medium" };
    case "Observer":
      return { label: "Observer", className: "border-line bg-sunken text-ink-3 font-normal" };
    default:
      return { label: role, className: "border-line bg-sunken text-ink-2 font-normal" };
  }
}

export function UserMenu() {
  const { user, availableUsers, switchUser } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const badge = getRoleBadge(user.defaultRole);
  const canApprove = user.permissions.includes("APPROVE_CRITICAL_ACTIONS");

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          "flex h-8 items-center gap-2 rounded-sm border border-line bg-sunken px-2.5 text-xs text-ink transition-colors",
          "hover:border-ink-4 focus:outline-none focus-visible:border-live",
          open && "border-ink-4 bg-raised",
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-raised font-mono text-2xs font-semibold text-ink-2 border border-line">
          {user.name.slice(0, 1)}
        </span>
        <span className="font-medium text-ink max-w-[100px] truncate text-2xs">
          {user.name}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.2 font-mono text-[10px] tracking-wide uppercase border",
            badge.className,
          )}
        >
          {badge.label}
        </span>
        <ChevronDown size={12} className={cn("text-ink-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="menu"
          aria-orientation="vertical"
          className={cn(
            "absolute right-0 top-full z-50 mt-1.5 w-64 rounded-md border border-line bg-raised shadow-xl",
            "p-1 text-xs text-ink outline-none",
          )}
        >
          <div className="border-b border-line px-2.5 py-2">
            <p className="text-2xs font-medium uppercase tracking-wider text-ink-4">
              Enterprise Identity (AuthN / RBAC)
            </p>
            <p className="mt-0.5 text-2xs text-ink-3">
              Switch persona to test multi-user concurrent roles & authorization
            </p>
          </div>

          <div className="py-1">
            {availableUsers.map((persona) => {
              const isCurrent = persona.id === user.id;
              const personaBadge = getRoleBadge(persona.defaultRole);
              const hasApproval = persona.permissions.includes("APPROVE_CRITICAL_ACTIONS");

              return (
                <button
                  key={persona.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void switchUser(persona.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded px-2.5 py-2 text-left transition-colors",
                    isCurrent ? "bg-sunken text-ink" : "hover:bg-sunken/60 text-ink-2",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-ink text-2xs truncate">
                        {persona.name}
                      </span>
                      {hasApproval && (
                        <span title="Authorized to approve critical actions">
                          <ShieldCheck size={12} className="text-live shrink-0" />
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={cn(
                          "rounded px-1 py-0.2 font-mono text-[9px] tracking-wide uppercase border",
                          personaBadge.className,
                        )}
                      >
                        {persona.defaultRole}
                      </span>
                      <span className="text-[10px] text-ink-4 truncate">{persona.email}</span>
                    </div>
                  </div>
                  {isCurrent && (
                    <span className="h-1.5 w-1.5 rounded-full bg-live shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t border-line px-2.5 py-1.5 text-[10px] text-ink-4">
            Current role authority:{" "}
            <span className={cn("font-medium", canApprove ? "text-live" : "text-ink-3")}>
              {canApprove ? "CRITICAL Approval Authority" : "Read / Standard Voice"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
