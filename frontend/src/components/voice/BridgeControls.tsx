"use client";

import { useEffect, useMemo, useState } from "react";
import { Mic, MicOff, PhoneOff, Radio } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
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
  "DevOps Lead",
  "Support Engineer",
  "Database Admin",
];

export function BridgeControls() {
  const { state, openBridge, closeBridge, micOn, toggleMic } = useIncident();
  const [channel, setChannel] = useState("inc-4417");
  const [role, setRole] = useState<ParticipantRole>("DevOps Lead");
  /** Roles already held on this channel, so this browser does not pick one. */
  const [taken, setTaken] = useState<readonly ParticipantRole[]>([]);

  const idle = state.bridge === "idle";
  const connecting = state.bridge === "connecting";

  /*
    ── WHY THE DROPDOWN HAS TO ASK THE ROSTER ──────────────────────────────
    Roles are exclusive per bridge and this control defaulted to "DevOps Lead"
    in EVERY browser, so the second and third person to open the console were
    holding a role the first one had already taken before they touched
    anything. Pressing J then produced a 409 from `/api/token`, and the console
    reported it as a microphone failure.

    That banner is fixed in `incident-store.tsx`, but a clear error for a
    collision that was guaranteed is still a worse product than not colliding.
    So the live roster is read before the join: taken roles are shown disabled
    in the list, and a browser sitting on one falls through to a free role (see
    `effectiveRole` below).

    Cheap and same-origin, and it re-runs when the channel is edited because
    "who is on inc-4417" says nothing about "who is on inc-9000". A failed
    fetch returns an empty map, which leaves every role selectable — the join
    still fails closed on the server, so the worst case is the message the
    operator would have got anyway.
  */
  useEffect(() => {
    if (!idle) return;
    const target = channel.trim();
    if (!target) return;

    let live = true;
    const timer = window.setTimeout(() => {
      void fetchRoster(target).then((roster) => {
        if (!live) return;
        setTaken([...new Set(roster.values())]);
      });
      // Debounced: this fires from a text input, and a keystroke per request
      // would hammer the route while somebody types a channel name.
    }, 250);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [channel, idle]);

  const free = useMemo(
    () => ROLES.filter((candidate) => !taken.includes(candidate)),
    [taken],
  );

  /*
    The role this browser will actually join as.

    DERIVED, not synced. The obvious version was an effect that called
    `setRole(free[0])` whenever the picked role turned out to be taken, which
    React rejects outright — a setState in an effect body cascades a second
    render for a value that was already knowable during the first one.

    So the roster's answer is applied here instead: if the selected role is
    taken and something else is free, this browser joins as that. The operator
    keeps whatever they explicitly chose as long as it is available, and
    `role` stays exactly what the dropdown shows.

    Deliberately NOT a hard block on joining. If every role is taken, this
    falls back to the selection and the server delivers the authoritative
    refusal naming what is free — one place decides, and it is the one holding
    the roster.
  */
  const effectiveRole = useMemo(
    () => (taken.includes(role) && free.length > 0 ? free[0] : role),
    [taken, role, free],
  );

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
        if (idle && channel.trim()) void openBridge({ channel, role: effectiveRole });
        else if (state.bridge === "live") closeBridge();
      }
      if (key === "m" && state.bridge === "live") {
        e.preventDefault();
        toggleMic();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idle, state.bridge, openBridge, closeBridge, toggleMic, channel, effectiveRole]);

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
            value={effectiveRole}
            onChange={(event) => setRole(event.target.value as ParticipantRole)}
            disabled={connecting}
            className="h-8 rounded-sm border border-line bg-sunken px-2 text-2xs text-ink outline-none focus:border-live"
          >
            {/*
              A taken role stays VISIBLE and disabled rather than being removed
              from the list. Three entries that silently become one tell the
              operator nothing; "Support Engineer (taken)" tells them the bridge
              already has one, which is the fact they need.
            */}
            {ROLES.map((candidate) => (
              <option
                key={candidate}
                value={candidate}
                disabled={taken.includes(candidate)}
              >
                {taken.includes(candidate) ? `${candidate} (taken)` : candidate}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="primary"
          onClick={() => void openBridge({ channel, role: effectiveRole })}
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
