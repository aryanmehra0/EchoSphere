"use client";

import { useEffect, useMemo, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio, UserCheck } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { useAuth } from "@/lib/auth-context";
import { fetchRoster } from "@/lib/delta-socket";
import { Button, Kbd } from "@/components/ui/Button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ParticipantRole } from "@/lib/types";

/**
 * Bridge transport controls.
 * Modernized with shadcn Button, Tooltip, and input styling.
 *
 * Two decisions worth naming:
 *
 * 1. Muted is the LOUD state, not the quiet one. Every conference tool gets
 *    this backwards and every meeting on earth contains someone talking into a
 *    muted mic. Here an open mic is unremarkable graphite; a muted one is
 *    outlined in critical red, because on an incident bridge the failure mode
 *    that costs real minutes is speaking into a dead channel.
 *
 * 2. Leaving requires a deliberate second target rather than sharing space
 *    with mute. Dropping off a Sev-1 bridge by mis-clicking is unacceptable, so
 *    the destructive control is isolated and separately styled.
 */

const ROLES: readonly ParticipantRole[] = [
  "Incident Commander",
  "DevOps Lead",
  "Site Reliability Engineer",
  "Database Admin",
  "Support Engineer",
  "Communications Lead",
  "Backend Engineer",
  "Security Engineer",
  "Network Engineer",
  "Observer",
];

export function BridgeControls() {
  const {
    state,
    openBridge,
    closeBridge,
    micOn,
    toggleMic,
    currentUid,
    currentRole,
    activeProject,
  } = useIncident();
  const { user } = useAuth();
  const [channel, setChannel] = useState("inc-4417");
  const [selectedRole, setSelectedRole] = useState<ParticipantRole | null>(null);
  const role = selectedRole ?? user.defaultRole;
  /** Active participants map on this channel: uid -> role. */
  const [activeRoster, setActiveRoster] = useState<Map<number, ParticipantRole>>(new Map());

  const idle = state.bridge === "idle";
  const connecting = state.bridge === "connecting";

  // Auto-sync channel with active project's primary incident if idle
  useEffect(() => {
    if (!idle) return;
    if (activeProject?.activeIncidents && activeProject.activeIncidents.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChannel(activeProject.activeIncidents[0].channel);
    }
  }, [activeProject, idle]);

  /*
    Multi-user roster awareness:
    Reads who is live on the channel so the operator sees the room's composition
    before joining. Multiple engineers can share roles (e.g. 2 DevOps Leads, 3 SREs).
  */
  useEffect(() => {
    if (!idle) return;
    const target = channel.trim();
    if (!target) return;

    let live = true;
    const timer = window.setTimeout(() => {
      void fetchRoster(target).then((roster) => {
        if (!live) return;
        setActiveRoster(roster);
      });
    }, 250);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [channel, idle]);

  const roleCounts = useMemo(() => {
    const counts = new Map<ParticipantRole, number>();
    for (const r of activeRoster.values()) {
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    return counts;
  }, [activeRoster]);

  /**
   * Keyboard transport. Operators work this console with both hands on a
   * keyboard while reading a dashboard, so the two controls that matter under
   * pressure are single keypresses. Guarded against firing while the operator
   * is typing into a field.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        if (idle && channel.trim()) {
          void openBridge({
            channel,
            role,
            userId: user.id,
            name: user.name,
          });
        } else if (state.bridge === "live") {
          closeBridge();
        }
      }
      if (key === "m" && state.bridge === "live") {
        e.preventDefault();
        toggleMic();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idle, state.bridge, openBridge, closeBridge, toggleMic, channel, role, user]);

  if (idle || connecting) {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[1fr_9.5rem] gap-1.5">
          <label className="sr-only" htmlFor="bridge-channel">Incident channel</label>
          <input
            id="bridge-channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            disabled={connecting}
            className="h-8 min-w-0 rounded-xs border border-line bg-sunken px-2.5 font-mono text-2xs text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-focus"
            placeholder="incident channel"
          />
          <label className="sr-only" htmlFor="bridge-role">Your incident role</label>
          <select
            id="bridge-role"
            value={role}
            onChange={(event) => setSelectedRole(event.target.value as ParticipantRole)}
            disabled={connecting}
            className="h-8 rounded-xs border border-line bg-sunken px-2 text-2xs text-ink outline-none transition-colors focus:border-focus cursor-pointer"
          >
            {ROLES.map((candidate) => {
              const count = roleCounts.get(candidate) || 0;
              return (
                <option key={candidate} value={candidate} className="bg-base text-ink">
                  {candidate} {count > 0 ? `(${count} active)` : ""}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex items-center justify-between px-0.5 text-[10px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <UserCheck size={12} className="text-live" />
            Joining as: <strong className="font-semibold text-ink">{user.name}</strong>
          </span>
          <span className="font-mono text-2xs text-ink-4">
            {activeRoster.size} on bridge
          </span>
        </div>
        <Button
          variant="primary"
          onClick={() => void openBridge({ channel, role, userId: user.id, name: user.name })}
          disabled={connecting || !channel.trim()}
          className="h-9 w-full justify-between px-3 cursor-pointer"
          icon={
            <span className="flex items-center gap-2">
              <Radio size={14} strokeWidth={2.2} />
              {connecting ? "Connecting to bridge…" : "Join incident bridge"}
            </span>
          }
        >
          {!connecting ? <Kbd>J</Kbd> : null}
        </Button>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-0.5 text-[11px] text-ink-3">
          <span className="truncate">
            Joined as <span className="font-medium text-ink">{user.name}</span> ({currentRole ?? role})
          </span>
          {currentUid && (
            <span className="font-mono text-2xs text-ink-4">UID {currentUid}</span>
          )}
        </div>
        <div className="flex gap-1.5">
          <Button
            variant={micOn ? "secondary" : "danger"}
            onClick={toggleMic}
            aria-pressed={!micOn}
            className="h-9 flex-1 justify-between px-3 cursor-pointer"
            icon={
              <span className="flex items-center gap-2">
                {micOn ? (
                  <Mic size={14} strokeWidth={2.2} />
                ) : (
                  <MicOff size={14} strokeWidth={2.2} className="text-critical" />
                )}
                <span className={cn(!micOn && "font-semibold text-critical")}>
                  {micOn ? "Microphone open" : "Muted"}
                </span>
              </span>
            }
          >
            <Kbd>M</Kbd>
          </Button>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="danger"
                onClick={closeBridge}
                aria-label="Leave incident bridge"
                className="h-9 w-9 px-0 cursor-pointer"
                icon={<PhoneOff size={14} strokeWidth={2.2} />}
              />
            </TooltipTrigger>
            <TooltipContent>Leave incident bridge (J)</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
