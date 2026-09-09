"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, MessageSquareText } from "lucide-react";

import { useIncident } from "@/lib/incident-store";
import { clock, initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/badge";
import { Button, Kbd } from "@/components/ui/Button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
        "enter-up group relative flex gap-2.5 px-3 py-2 transition-colors",
        isEcho && "bg-live/[0.04]",
      )}
    >
      {/* Left rule doubles as the speaker's identity anchor down the column. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[2px]",
          isEcho ? "bg-live" : "bg-transparent",
        )}
      />

      <Avatar
        className={cn(
          "mt-px h-5 w-5 shrink-0 border transition-all",
          isEcho
            ? "border-live/40 bg-live/15"
            : "border-line bg-overlay",
        )}
      >
        <AvatarFallback
          className={cn(
            "text-[9px] font-mono font-semibold",
            isEcho ? "text-live bg-live/20" : "text-ink-3 bg-overlay",
          )}
        >
          {initials(t.role)}
        </AvatarFallback>
      </Avatar>

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
            <Badge variant="neutral" className="ml-auto py-0 px-1 text-[8px]">
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
              "text-2xs font-medium text-ink-2 shadow-lg transition-colors hover:bg-hover hover:text-ink cursor-pointer",
            )}
          >
            Jump to live
          </button>
        ) : null}
      </div>

      <TranscriptReview open={showReview} onOpenChange={setShowReview} />
    </>
  );
}

/**
 * The full-transcript review surface.
 * Modernized with shadcn Dialog primitive.
 */
function TranscriptReview({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state } = useIncident();
  const endRef = useRef<HTMLDivElement>(null);

  const finals = state.transcripts.filter((t) => t.isFinal).length;

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [open, state.transcripts.length]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[76vh] flex flex-col p-0 gap-0 overflow-hidden border-line-strong bg-raised shadow-2xl">
        <DialogHeader className="flex flex-row items-center justify-between border-b border-line-faint px-4 py-2.5 space-y-0">
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-ink-3" />
            <DialogTitle className="text-xs font-mono font-medium tracking-wider uppercase text-ink">
              Everything Echo has heard so far
            </DialogTitle>
          </div>
          <span className="tnum font-mono text-2xs text-ink-4 pr-6">
            {finals} final / {state.transcripts.length} total
          </span>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  );
}
