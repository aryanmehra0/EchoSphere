"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, MessageSquareText, X } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { clock, initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Signal";
import { Button, Kbd } from "@/components/ui/Button";
import type { Transcript } from "@/lib/types";

/**
 * The live transcript.
 *
 * Speaker identity is carried by an initials chip and a name, NOT by colour.
 * Assigning every participant a hue is the reflex here, and it is wrong: it
 * burns the palette on decoration and leaves red meaning "Priya" in one pane
 * and "the database is on fire" in another. Echo is the single exception,
 * because `live` is defined system-wide as the agent's colour.
 *
 * Partial frames render dimmed with a caret. This makes the deduplication
 * visible as a feature — you watch a sentence assemble itself and then settle —
 * rather than as invisible plumbing.
 */

/** One diarised turn. Shared by the live feed and the full-transcript review. */
export function TranscriptRow({ t }: { t: Transcript }) {
  const isEcho = t.role === "Echo";

  return (
    <li
      className={cn(
        "enter-up group relative flex gap-2.5 px-3 py-2",
        // Echo's turns are inset and washed so the agent's contributions are
        // never mistaken for a human's when scanning the log later.
        isEcho && "bg-live/[0.04]",
      )}
    >
      {/* Left rule doubles as the speaker's identity anchor down the column. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-px",
          isEcho ? "bg-live/50" : "bg-transparent",
        )}
      />

      <span
        aria-hidden
        className={cn(
          "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-xs border font-mono text-[9px] font-semibold",
          isEcho
            ? "border-live/35 bg-live/12 text-live"
            : "border-line bg-overlay text-ink-3",
        )}
      >
        {initials(t.role)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span
            className={cn(
              "text-2xs font-semibold tracking-tight",
              isEcho ? "text-live" : "text-ink-2",
            )}
          >
            {t.role}
          </span>
          <span className="tnum font-mono text-[9px] text-ink-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            {clock(t.at)}
          </span>
          {!t.isFinal ? (
            <Badge tone="neutral" className="ml-auto py-0 text-[8px]">
              partial
            </Badge>
          ) : null}
        </div>

        <p
          className={cn(
            "text-xs leading-[1.5]",
            t.isFinal ? "text-ink-2" : "text-ink-3",
          )}
        >
          {t.text}
          {!t.isFinal ? (
            <span
              aria-hidden
              className="beacon ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] bg-ink-3"
            />
          ) : null}
        </p>
      </div>
    </li>
  );
}

export function TranscriptFeed() {
  const { state } = useIncident();
  const scroller = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  /**
   * Follow-the-tail scrolling, but only while the operator is actually at the
   * tail. Yanking the viewport back down while somebody is reading two minutes
   * of backlog is one of the fastest ways to make a live feed unusable, so we
   * track intent and hand back control the moment they scroll away.
   */
  const [pinned, setPinned] = useState(true);

  const [showReview, setShowReview] = useState(false);

  /**
   * Keyboard transport. `T` pulls the full transcript of everything Echo has
   * heard so far into a review surface, because on a live bridge the operator
   * is holding the keyboard, not on it. Guarded against firing while typing
   * into a field, same as J/M — see BridgeControls.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
      ) {
        return;
      }
      if (e.key.toLowerCase() === "t") {
        e.preventDefault();
        setShowReview((v) => !v);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distance < 48);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Layout effect, not effect: scroll before paint so the tail never flashes.
  useLayoutEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: "end" });
  }, [state.transcripts, pinned]);

  const finals = state.transcripts.filter((t) => t.isFinal).length;

  return (
    <>
      <PanelHeader
        title="Transcript"
        icon={<MessageSquareText size={11} strokeWidth={2.2} />}
        aside={
          <span className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowReview(true)}
              title="Show the full transcript of everything heard so far"
              aria-label="Show the full transcript"
              className="h-5 gap-1 px-1.5"
              icon={<Maximize2 size={11} strokeWidth={2.2} />}
            >
              <Kbd>t</Kbd>
            </Button>
            <span className="tnum font-mono text-2xs text-ink-4">
              {finals}/{state.transcripts.length}
            </span>
          </span>
        }
      />

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="scroll-thin h-full overflow-y-auto">
          {state.transcripts.length === 0 ? (
            <EmptyState
              icon={<MessageSquareText size={13} strokeWidth={2} />}
              title="No speech captured"
              hint="Diarised turns appear here as each participant is transcribed."
            />
          ) : (
            <ul
              className="divide-y divide-line-faint"
              aria-live="polite"
              aria-relevant="additions"
            >
              {state.transcripts.map((t) => (
                <TranscriptRow key={t.messageId} t={t} />
              ))}
            </ul>
          )}
          <div ref={endRef} />
        </div>

        {/* Return-to-live affordance, shown only when the operator has
            scrolled away from the tail and is therefore missing new turns. */}
        {!pinned && state.transcripts.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setPinned(true);
              endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
            className={cn(
              "absolute inset-x-0 bottom-2 mx-auto w-fit rounded-xs border border-line-strong bg-overlay px-2 py-1",
              "text-2xs font-medium text-ink-2 shadow-lg transition-colors hover:bg-hover hover:text-ink",
            )}
          >
            Jump to live
          </button>
        ) : null}
      </div>

      {showReview ? (
        <TranscriptReview onClose={() => setShowReview(false)} />
      ) : null}
    </>
  );
}

/**
 * The full-transcript review surface.
 *
 * Everything Echo has heard so far, in one tall scrollable read — the fixed
 * 352px voice column cannot carry a long conversation legibly, and an operator
 * arriving mid-incident has no other way to establish what happened before
 * them. It is a copy of the reducer's feed, not a re-derivation, so a turn the
 * live pane shows is exactly what review shows.
 */
function TranscriptReview({ onClose }: { onClose: () => void }) {
  const { state } = useIncident();
  const dialog = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const finals = state.transcripts.filter((t) => t.isFinal).length;

  // Esc closes, like every other transient surface in this console; arriving
  // with keyboard focus in the dialog keeps the operator's hands on the board.
  useEffect(() => {
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Tail-follow in review too: new turns land while the operator reads, and
  // they should appear rather than wait for a scroll.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [state.transcripts.length]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-void/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Full transcript"
      onMouseDown={(e) => {
        if (e.target === dialog.current?.parentElement) onClose();
      }}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        className="enter-up flex max-h-[76vh] w-full max-w-[760px] flex-col overflow-hidden rounded-md border border-line-strong bg-raised outline-none"
      >
        <div className="flex items-center gap-2 border-b border-line-faint px-4 py-2">
          <MessageSquareText size={13} strokeWidth={2.2} className="text-ink-3" />
          <span className="eyebrow">Everything Echo has heard so far</span>
          <span className="tnum ml-auto font-mono text-2xs text-ink-4">
            {finals} final / {state.transcripts.length} total
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close transcript review"
            className="h-5 px-1.5"
            icon={<X size={12} strokeWidth={2.2} />}
          />
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {state.transcripts.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<MessageSquareText size={13} strokeWidth={2} />}
                title="Nothing heard yet"
                hint="Join the bridge and speak — every diarised turn lands in the ledger of speech."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line-faint">
              {state.transcripts.map((t) => (
                <TranscriptRow key={t.messageId} t={t} />
              ))}
            </ul>
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
