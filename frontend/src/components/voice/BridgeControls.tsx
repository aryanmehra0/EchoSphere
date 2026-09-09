"use client";

import { useEffect, useMemo, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio, UserCheck } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { useAuth } from "@/lib/auth-context";
import { fetchRoster } from "@/lib/delta-socket";
import { Button, Kbd } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { ParticipantRole } from "@/lib/types";

/**
 * Bridge transport controls.
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
/**
 * The joinable roles, in the order the dropdown offers them.
 *
 * Kept in step with VALID_ROLES in `/api/token` — the server is authoritative
 * and rejects anything else, so a drift here shows up as a 400 rather than as
 * a silently wrong participant. Echo is absent on purpose: a human may never
 * claim the agent's identity, because `kind: "agent"` drives the self-audio
 * exclusion.
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
  const { state, openBridge, closeBridge, micOn, toggleMic, currentUid, currentRole } = useIncident();
  const { user } = useAuth();
  const [channel, setChannel] = useState("inc-4417");
  const [selectedRole, setSelectedRole] = useState<ParticipantRole | null>(null);
  const role = selectedRole ?? user.defaultRole;
  /** Active participants map on this channel: uid -> role. */
  const [activeRoster, setActiveRoster] = useState<Map<number, ParticipantRole>>(new Map());

  const idle = state.bridge === "idle";
  const connecting = state.bridge === "connecting";

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
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-[1fr_9.5rem] gap-1.5">
          <label className="sr-only" htmlFor="bridge-channel">Incident channel</label>
          <input
            id="bridge-channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            disabled={connecting}
            className="h-8 min-w-0 rounded-sm border border-line bg-sunken px-2 font-mono text-2xs text-ink outline-none placeholder:text-ink-4 focus:border-live"
            placeholder="incident channel"
          />
          <label className="sr-only" htmlFor="bridge-role">Your incident role</label>
          <select
            id="bridge-role"
            value={role}
            onChange={(event) => setSelectedRole(event.target.value as ParticipantRole)}
            disabled={connecting}
            className="h-8 rounded-sm border border-line bg-sunken px-2 text-2xs text-ink outline-none focus:border-live"
          >
            {ROLES.map((candidate) => {
              const count = roleCounts.get(candidate) || 0;
              return (
                <option key={candidate} value={candidate}>
                  {candidate} {count > 0 ? `(${count} active)` : ""}
                </option>
              );
            })}
          </select>
        </div>
        <div className="flex items-center justify-between px-0.5 text-[10px] text-ink-3">
          <span className="flex items-center gap-1">
            <UserCheck size={11} className="text-live" />
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
          className="h-9 w-full justify-between px-3"
          icon={
            <span className="flex items-center gap-2">
              <Radio size={14} strokeWidth={2.2} />
              {connecting ? "Connecting to bridge" : "Join incident bridge"}
            </span>
          }
        >
          {!connecting ? <Kbd>J</Kbd> : null}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
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
          className="h-9 flex-1 justify-between px-3"
          icon={
            <span className="flex items-center gap-2">
              {micOn ? (
                <Mic size={14} strokeWidth={2.2} />
              ) : (
                <MicOff size={14} strokeWidth={2.2} />
              )}
              <span className={cn(!micOn && "font-semibold")}>
                {micOn ? "Microphone open" : "Muted"}
              </span>
            </span>
          }
        >
          <Kbd>M</Kbd>
        </Button>

        <Button
          variant="danger"
          onClick={closeBridge}
          aria-label="Leave incident bridge"
          title="Leave incident bridge"
          className="h-9 w-9 px-0"
          icon={<PhoneOff size={14} strokeWidth={2.2} />}
        />
      </div>
    </div>
  );
}
