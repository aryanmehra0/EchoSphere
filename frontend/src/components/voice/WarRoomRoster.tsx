"use client";

import { useMemo, useState } from "react";
import { Mic, MicOff, ShieldCheck, Users, Volume2 } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { useAuth } from "@/lib/auth-context";
import { initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RosterParticipant } from "@/lib/types";

/**
 * War Room Roster & Audio Speaking Radar.
 * Modernized with shadcn Avatar, Badge, and Tooltip primitives.
 *
 * Displays all active participants on the bridge with:
 * - Real-time WebRTC audio speaking radar (pulsing emerald halo when speaking).
 * - Operator name and human identity.
 * - Role badges and cryptographic approval entitlement indicators.
 * - Agent Echo presence and listening status.
 */
export function WarRoomRoster() {
  const { state, currentUid, currentRole, activeSpeakers, participants, micOn, now } = useIncident();
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const isLive = state.bridge === "live";

  // Build the effective list of participants:
  const effectiveParticipants = useMemo<RosterParticipant[]>(() => {
    if (participants.length > 0) {
      return participants;
    }
    if (isLive && currentUid) {
      return [
        {
          uid: currentUid,
          role: currentRole ?? user.defaultRole,
          kind: "human",
          authorized: ["Incident Commander", "DevOps Lead"].includes(currentRole ?? user.defaultRole),
          issuedAt: now,
          userId: user.id,
          name: user.name,
          permissions: user.permissions,
        },
      ];
    }
    return [];
  }, [participants, isLive, currentUid, currentRole, user, now]);

  const humans = effectiveParticipants.filter((p) => p.kind === "human");
  const isEchoSpeaking = state.agent === "speaking" || activeSpeakers.has(9000);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-1.5 border-b border-line-faint p-2.5">
        <div className="flex items-center justify-between text-[11px]">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-1.5 text-xs font-semibold text-ink hover:text-ink transition-colors cursor-pointer select-none"
            aria-expanded={!collapsed}
          >
            <Users className="h-3.5 w-3.5 text-ink-3" />
            <span>War Room Presence</span>
            <Badge variant="neutral" className="ml-1 px-1 py-0 text-[9px]">
              {humans.length + (isLive ? 1 : 0)}
            </Badge>
          </button>

          {isLive && (
            <Badge variant="live" className="gap-1 px-1.5 py-0 text-[9px]">
              <span className="h-1.5 w-1.5 rounded-full bg-live animate-pulse" />
              LIVE BRIDGE
            </Badge>
          )}
        </div>

        {!collapsed && (
          <div className="flex flex-col gap-1 pt-1">
            {humans.length === 0 && !isLive ? (
              <div className="rounded-xs border border-line-faint bg-sunken/40 p-2.5 text-center text-2xs text-ink-4">
                Bridge idle — press <span className="font-mono text-ink font-semibold">J</span> to join the war room
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {humans.map((p) => {
                  const isSelf = p.uid === currentUid;
                  const isSpeaking = activeSpeakers.has(p.uid);
                  const displayName = p.name ?? (isSelf ? user.name : `Engineer #${p.uid}`);

                  return (
                    <li
                      key={p.uid}
                      className={cn(
                        "group flex items-center justify-between gap-2 rounded-xs border px-2 py-1.5 transition-colors",
                        isSpeaking
                          ? "border-live/40 bg-live/[0.07]"
                          : "border-line-faint bg-overlay/60 hover:bg-overlay",
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {/* Avatar with Audio Radar Ring */}
                        <div className="relative flex shrink-0 items-center justify-center">
                          <Avatar
                            className={cn(
                              "h-6 w-6 transition-all",
                              isSpeaking
                                ? "border-live ring-2 ring-live/30 ring-offset-1 ring-offset-base"
                                : "border-line",
                            )}
                          >
                            <AvatarFallback
                              className={cn(
                                "text-[10px] font-semibold",
                                isSpeaking ? "bg-live/20 text-live" : "bg-sunken text-ink-3",
                              )}
                            >
                              {initials(displayName)}
                            </AvatarFallback>
                          </Avatar>
                          {isSpeaking && (
                            <span
                              aria-hidden
                              className="absolute -inset-0.5 animate-ping rounded-full bg-live/30 opacity-75"
                            />
                          )}
                        </div>

                        {/* Identity and Role */}
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-1.5 leading-none">
                            <span className="truncate text-xs font-medium text-ink">
                              {displayName}
                            </span>
                            {isSelf && (
                              <Badge variant="neutral" className="px-1 py-0 text-[8px]">
                                YOU
                              </Badge>
                            )}
                          </div>
                          <span className="truncate text-[10px] text-ink-4 leading-tight mt-0.5 font-mono">
                            {p.role}
                          </span>
                        </div>
                      </div>

                      {/* Status badges & controls */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        {p.authorized && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-amber-400 cursor-help">
                                <ShieldCheck className="h-3.5 w-3.5" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Authorized to approve critical runbook actions</TooltipContent>
                          </Tooltip>
                        )}

                        {isSelf ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                {micOn ? (
                                  <Mic className={cn("h-3.5 w-3.5", isSpeaking ? "text-live" : "text-ink-4")} />
                                ) : (
                                  <MicOff className="h-3.5 w-3.5 text-critical" />
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{micOn ? "Microphone active" : "Microphone muted"}</TooltipContent>
                          </Tooltip>
                        ) : isSpeaking ? (
                          <span className="flex items-center gap-0.5 text-live">
                            <span className="inline-block h-2.5 w-[1.5px] bg-live animate-pulse" />
                            <span className="inline-block h-3.5 w-[1.5px] bg-live animate-pulse delay-75" />
                            <span className="inline-block h-2 w-[1.5px] bg-live animate-pulse delay-150" />
                          </span>
                        ) : (
                          <span className="font-mono text-[9px] text-ink-5">UID {p.uid}</span>
                        )}
                      </div>
                    </li>
                  );
                })}

                {/* Echo AI Secretary Presence */}
                {isLive && (
                  <li
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-xs border px-2 py-1.5 transition-colors",
                      isEchoSpeaking
                        ? "border-live/50 bg-live/[0.08]"
                        : "border-line-faint bg-live/[0.02]",
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="relative flex shrink-0 items-center justify-center">
                        <Avatar
                          className={cn(
                            "h-6 w-6 border transition-all",
                            isEchoSpeaking
                              ? "border-live ring-2 ring-live/40 ring-offset-1 ring-offset-base"
                              : "border-live/40",
                          )}
                        >
                          <AvatarFallback className="bg-live/15 font-mono text-[10px] font-bold text-live">
                            E
                          </AvatarFallback>
                        </Avatar>
                      </div>

                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5 leading-none">
                          <span className="text-xs font-semibold text-live">Echo</span>
                          <span className="font-mono text-[8px] text-ink-4">AI SECRETARY</span>
                        </div>
                        <span className="truncate text-[10px] text-ink-3 leading-tight mt-0.5">
                          {state.agent === "speaking"
                            ? "Speaking finding"
                            : state.agent === "thinking"
                              ? "Deliberating"
                              : "Listening to bridge"}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isEchoSpeaking ? (
                        <span className="flex items-center gap-0.5 text-live">
                          <Volume2 className="h-3 w-3 animate-pulse text-live mr-0.5" />
                          <span className="inline-block h-2.5 w-[1.5px] bg-live animate-pulse" />
                          <span className="inline-block h-3.5 w-[1.5px] bg-live animate-pulse delay-75" />
                          <span className="inline-block h-2 w-[1.5px] bg-live animate-pulse delay-150" />
                        </span>
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-live" />
                      )}
                    </div>
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
