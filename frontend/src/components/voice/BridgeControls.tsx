"use client";

import { useEffect, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
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
export function BridgeControls() {
  const { state, openBridge, closeBridge, micOn, toggleMic } = useIncident();
  const [channel, setChannel] = useState("inc-4417");
  const [role, setRole] = useState<ParticipantRole>("DevOps Lead");

  const idle = state.bridge === "idle";
  const connecting = state.bridge === "connecting";

  /**
   * Keyboard transport. Operators work this console with both hands on a
   * keyboard while reading a dashboard, so the two controls that matter under
   * pressure are single keypresses. Guarded against firing while the operator
   * is typing into a field — a rule people forget until someone drops the
   * bridge by typing "j" into a search box.
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
        if (idle && channel.trim()) void openBridge({ channel, role });
        else if (state.bridge === "live") closeBridge();
      }
      if (key === "m" && state.bridge === "live") {
        e.preventDefault();
        toggleMic();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idle, state.bridge, openBridge, closeBridge, toggleMic, channel, role]);

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
            onChange={(event) => setRole(event.target.value as ParticipantRole)}
            disabled={connecting}
            className="h-8 rounded-sm border border-line bg-sunken px-2 text-2xs text-ink outline-none focus:border-live"
          >
            <option>DevOps Lead</option>
            <option>Support Engineer</option>
            <option>Database Admin</option>
          </select>
        </div>
        <Button
          variant="primary"
          onClick={() => void openBridge({ channel, role })}
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
  );
}
