"use client";

import { useState } from "react";
import { Link2, ListChecks } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { selectClaimsByIds } from "@/lib/incident-reducer";
import { clockShort, initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, taskTone } from "@/components/ui/Signal";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Task, TaskStatus } from "@/lib/types";

/**
 * Action items.
 *
 * Two things this panel refuses to do:
 *
 * 1. It never shows an unowned task. Every row leads with a role, because
 *    "someone should check the replica" is how follow-ups get lost. If the
 *    extraction model cannot attribute an action, that is a gap the operator
 *    needs to see, not a blank to hide.
 *
 * 2. It never lets the UI silently mutate a task that the backend owns. The
 *    status control dispatches through the same reducer as everything else, so
 *    when the Proxy Action Layer lands in Phase 3 it becomes the authority and
 *    this control becomes an optimistic local echo — no rewrite required.
 */

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  OPEN: "IN_PROGRESS",
  IN_PROGRESS: "DONE",
  BLOCKED: "IN_PROGRESS",
  DONE: "OPEN",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "Active",
  BLOCKED: "Awaiting auth",
  DONE: "Done",
};

function Row({ task }: { task: Task }) {
  const { state, dispatch } = useIncident();
  const [showEvidence, setShowEvidence] = useState(false);
  const evidence = selectClaimsByIds(state, task.evidence);
  const done = task.status === "DONE";

  return (
    <li className="enter-up group flex gap-2.5 px-3 py-2.5">
      {/* The checkbox advances the task's lifecycle rather than toggling a
          boolean — BLOCKED → Active → Done is the real sequence on a bridge. */}
      <button
        type="button"
        onClick={() =>
          dispatch({
            type: "TASK_STATUS",
            id: task.id,
            status: NEXT_STATUS[task.status],
          })
        }
        aria-label={`${task.description} — currently ${STATUS_LABEL[task.status]}. Advance status.`}
        className={cn(
          "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-150",
          done
            ? "border-stable/50 bg-stable/15 text-stable"
            : task.status === "BLOCKED"
              ? "border-critical/45 bg-critical/10"
              : "border-line-strong bg-sunken hover:border-ink-3",
        )}
      >
        {done ? (
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
            <path
              d="M1.5 5.2 L3.9 7.5 L8.5 2.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : task.status === "BLOCKED" ? (
          <span className="h-1.5 w-1.5 rounded-full bg-critical" aria-hidden />
        ) : null}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-xs leading-snug",
            done ? "text-ink-4 line-through" : "text-ink-2",
          )}
        >
          {task.description}
        </p>

        <div className="mt-1.5 flex items-center gap-2">
          <span
            aria-hidden
            className="flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border border-line bg-overlay font-mono text-[7px] font-semibold text-ink-3"
          >
            {initials(task.assigneeRole)}
          </span>
          <span className="truncate text-[9px] text-ink-4">
            {task.assigneeRole}
          </span>

          {task.ref ? (
            <span
              className="rounded-[2px] border border-line bg-sunken px-1 font-mono text-[8px] text-ink-3"
              title="External ticket reference"
            >
              {task.ref}
            </span>
          ) : null}

          <Badge tone={taskTone[task.status]} variant="outline" className="ml-auto">
            {STATUS_LABEL[task.status]}
          </Badge>

          <span className="tnum font-mono text-[9px] text-ink-4">
            {clockShort(task.at)}
          </span>
        </div>

        {/*
          The evidence chain (v6 §9.4).

          Every task links back to the claims that justify it, so "why are we
          doing this?" is answerable at close-out — and so the Authorization
          Gate modal can show a human exactly what they are approving against.
          Collapsed by default: it is reference material, not scanning material.
        */}
        {evidence.length > 0 ? (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setShowEvidence((v) => !v)}
              aria-expanded={showEvidence}
              className={cn(
                "flex items-center gap-1 rounded-xs text-[9px] transition-colors",
                showEvidence ? "text-ink-2" : "text-ink-4 hover:text-ink-3",
              )}
            >
              <Link2 size={9} strokeWidth={2.2} />
              {evidence.length} claim{evidence.length > 1 ? "s" : ""} as evidence
            </button>

            {showEvidence ? (
              <ul className="mt-1.5 space-y-1 border-l border-line pl-2">
                {evidence.map((c) => (
                  <li key={c.id} className="text-[10px] leading-snug text-ink-3">
                    <span className="text-ink-4">{c.speakerRole}:</span> {c.text}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function TasksPanel() {
  const { state } = useIncident();

  if (state.tasks.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks size={13} strokeWidth={2} />}
        title="No action items"
        hint="Commitments made aloud are captured here with their owner attached."
      />
    );
  }

  // Open work first, completed work sunk to the bottom. During an incident the
  // only question this panel answers is "what is still outstanding".
  const ordered = [...state.tasks].sort((a, b) => {
    const aDone = a.status === "DONE" ? 1 : 0;
    const bDone = b.status === "DONE" ? 1 : 0;
    return aDone - bDone || a.at - b.at;
  });

  return (
    <ul className="divide-y divide-line-faint">
      {ordered.map((t) => (
        <Row key={t.id} task={t} />
      ))}
    </ul>
  );
}
