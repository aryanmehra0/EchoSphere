"use client";

import { ChevronDown, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/cn";
import type { ParticipantRole } from "@/lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

function getRoleBadgeVariant(role: ParticipantRole): {
  label: string;
  variant: "live" | "warning" | "stable" | "critical" | "neutral" | "soft";
  className?: string;
} {
  switch (role) {
    case "Incident Commander":
      return { label: "IC", variant: "live" };
    case "DevOps Lead":
      return { label: "DevOps", variant: "soft", className: "border-cyan-500/40 bg-cyan-500/15 text-cyan-400" };
    case "Site Reliability Engineer":
      return { label: "SRE", variant: "soft", className: "border-blue-500/40 bg-blue-500/15 text-blue-400" };
    case "Database Admin":
      return { label: "DBA", variant: "warning" };
    case "Observer":
      return { label: "Observer", variant: "neutral" };
    default:
      return { label: role, variant: "soft" };
  }
}

export function UserMenu() {
  const { user, availableUsers, switchUser } = useAuth();

  const badge = getRoleBadgeVariant(user.defaultRole);
  const canApprove = user.permissions.includes("APPROVE_CRITICAL_ACTIONS");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-2 rounded-xs border border-line bg-sunken px-2.5 text-xs text-ink transition-colors",
            "hover:border-line-strong hover:bg-raised focus-visible:outline-none focus-visible:border-focus select-none cursor-pointer",
            "data-[state=open]:border-line-strong data-[state=open]:bg-raised",
          )}
        >
          <Avatar className="h-5 w-5 border border-line">
            <AvatarFallback className="text-[10px] font-semibold text-ink-2">
              {user.name.slice(0, 1)}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-ink max-w-[100px] truncate text-2xs">
            {user.name}
          </span>
          <Badge
            variant={badge.variant}
            className={cn("px-1 py-0 text-[9px] uppercase", badge.className)}
          >
            {badge.label}
          </Badge>
          <ChevronDown className="h-3 w-3 text-ink-3 transition-transform duration-200 ease-[var(--ease-out)]" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-80 border-line-strong bg-base p-1.5 shadow-2xl"
      >
        <DropdownMenuLabel className="px-2 py-1 text-ink-4">
          <p className="text-[10px] font-mono uppercase tracking-wider">Enterprise Identity</p>
          <p className="font-normal text-[11px] text-ink-3 tracking-normal normal-case mt-0.5">
            Switch persona to test multi-user RBAC and action gating
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <div className="space-y-0.5 py-1">
          {availableUsers.map((persona) => {
            const isCurrent = persona.id === user.id;
            const personaBadge = getRoleBadgeVariant(persona.defaultRole);
            const hasApproval = persona.permissions.includes("APPROVE_CRITICAL_ACTIONS");

            return (
              <DropdownMenuItem
                key={persona.id}
                onClick={() => {
                  void switchUser(persona.id);
                }}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-xs px-2.5 py-2 cursor-pointer transition-colors",
                  isCurrent ? "bg-sunken text-ink font-medium" : "text-ink-2 hover:bg-hover hover:text-ink",
                )}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Avatar className="h-6 w-6 border border-line">
                    <AvatarFallback className="text-[10px]">
                      {persona.name.slice(0, 1)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs text-ink font-medium">
                        {persona.name}
                      </span>
                      {hasApproval && (
                        <ShieldCheck
                          className="h-3 w-3 text-live shrink-0"
                          aria-label="Authorized to approve critical actions"
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge
                        variant={personaBadge.variant}
                        className={cn("px-1 py-0 text-[8px] uppercase", personaBadge.className)}
                      >
                        {persona.defaultRole}
                      </Badge>
                      <span className="text-[10px] text-ink-4 truncate font-mono">
                        {persona.email}
                      </span>
                    </div>
                  </div>
                </div>

                {isCurrent && (
                  <span className="h-1.5 w-1.5 rounded-full bg-live shrink-0" />
                )}
              </DropdownMenuItem>
            );
          })}
        </div>

        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] font-mono text-ink-4">
          Current authority:{" "}
          <span className={cn("font-medium", canApprove ? "text-live" : "text-ink-3")}>
            {canApprove ? "CRITICAL Approval Authority" : "Read / Standard Voice"}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
