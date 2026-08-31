import type {
  AgentState,
  BridgeState,
  Claim,
  IncidentDelta,
  IncidentState,
  TaskStatus,
  Transcript,
  ApprovalRequest,
} from "./types";

/**
 * The single source of truth for incident state.
 *
 * This is a pure reducer with no React, no network and no timers, which means
 * the whole Phase 3 pipeline can be tested by feeding it recorded deltas. The
 * RTM deduplication algorithm lives here rather than in a component because it
 * is domain logic, not view logic — the same rule has to hold whether a frame
 * arrives from Agora RTM, a replayed fixture, or a reconnect backfill.
 */

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

export type IncidentAction =
  /** A JSON delta from the Slow Loop analytics WebSocket. */
  | { type: "DELTA"; payload: IncidentDelta }
  /**
   * The server's authoritative full state, from a HELLO handshake (v6 §9.3).
   *
   * Distinct from DELTA because a snapshot must REPLACE the collections rather
   * than merge into them. Merging would silently preserve rows the server has
   * since dropped — a reconnecting dashboard would show claims that no longer
   * exist, which is worse than showing nothing.
   */
  | { type: "SNAPSHOT"; payload: IncidentDelta }
  /** One RTM transcript frame, partial or final. */
  | { type: "TRANSCRIPT"; payload: Transcript }
  | { type: "BRIDGE"; state: BridgeState; at?: number }
  | { type: "AGENT"; state: AgentState }
  | { type: "RTI"; value: number }
  | { type: "TASK_STATUS"; id: string; status: TaskStatus }
  | { type: "RESOLVE_CONTRADICTION"; id: string }
  /** A CRITICAL action needs a human (v6 §10.2). */
  | { type: "APPROVAL_REQUEST"; payload: ApprovalRequest }
  /** Approved, denied or expired — the modal comes down either way. */
  | { type: "APPROVAL_RESOLVED" }
  | { type: "RESET" };

/* -------------------------------------------------------------------------- */
/* Initial state                                                               */
/* -------------------------------------------------------------------------- */

export const initialIncidentState: IncidentState = {
  id: "INC-4417",
  title: "Checkout latency & 5xx surge",
  severity: 1,
  phase: "standby",
  startedAt: null,
  bridge: "idle",
  agent: "offline",
  rti: 0,
  entities: [],
  links: [],
  claims: [],
  unchecked: [],
  tasks: [],
  contradictions: [],
  timeline: [],
  transcripts: [],
  approval: null,
  degraded: null,
  // Recording is the default. An incident bridge that silently failed to
  // record itself would be its own kind of failure — but the default is
  // stated here rather than assumed by every component that reads it.
  privacy: { recording: true, suspendedTurns: 0, since: null, changedBy: null },
};

/* -------------------------------------------------------------------------- */
/* Merge helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Upsert by `id`, preserving original ordering for items already present.
 *
 * The Slow Loop re-sends an entity whenever its status changes (OK → CRITICAL),
 * so a naive append would duplicate nodes on the canvas. Merging in place also
 * means React Flow keeps the node mounted and animates the status transition
 * instead of remounting it.
 */
function upsert<T extends { id: string }>(existing: T[], incoming?: T[]): T[] {
  if (!incoming?.length) return existing;

  const index = new Map(existing.map((item, i) => [item.id, i]));
  const next = [...existing];

  for (const item of incoming) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, next.length);
      next.push(item);
    } else {
      next[at] = { ...next[at], ...item };
    }
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                     */
/* -------------------------------------------------------------------------- */

export function incidentReducer(
  state: IncidentState,
  action: IncidentAction,
): IncidentState {
  switch (action.type) {
    case "DELTA": {
      const d = action.payload;
      return {
        ...state,
        entities: upsert(state.entities, d.entities),
        links: upsert(state.links, d.links),
        claims: upsert(state.claims, d.claims),
        unchecked: upsert(state.unchecked, d.unchecked),
        tasks: upsert(state.tasks, d.tasks),
        contradictions: upsert(state.contradictions, d.contradictions),
        // The timeline is the one collection that stays strictly chronological,
        // because an operator reads it as a narrative rather than a set.
        timeline: upsert(state.timeline, d.timeline).sort((a, b) => a.at - b.at),
        rti: d.rti ?? state.rti,
        phase: d.phase ?? state.phase,
        agent: d.agent ?? state.agent,
        // `undefined` means "unchanged"; an explicit null means "recovered".
        degraded: d.degraded === undefined ? state.degraded : d.degraded,
        privacy: d.privacy ?? state.privacy,
      };
    }

    /**
     * Full state from the server (v6 §9.3).
     *
     * Replaces every server-owned collection and preserves everything the
     * CLIENT owns: the transport state, the incident clock, and the transcript
     * feed. The server's snapshot has no opinion about whether this browser is
     * connected, and applying one must never drop the operator's scrollback.
     */
    case "SNAPSHOT": {
      const d = action.payload;
      return {
        ...state,
        entities: d.entities ?? [],
        links: d.links ?? [],
        claims: d.claims ?? [],
        unchecked: d.unchecked ?? [],
        tasks: d.tasks ?? [],
        contradictions: d.contradictions ?? [],
        timeline: [...(d.timeline ?? [])].sort((a, b) => a.at - b.at),
        rti: d.rti ?? state.rti,
        phase: d.phase ?? state.phase,
        agent: d.agent ?? state.agent,
        // `undefined` means "unchanged"; an explicit null means "recovered".
        degraded: d.degraded === undefined ? state.degraded : d.degraded,
        privacy: d.privacy ?? state.privacy,
      };
    }

    /**
     * RTM transcript deduplication (master doc §9, risk 8).
     *
     * Agora emits an utterance as a burst of frames sharing one `messageId`,
     * each carrying a longer prefix of the sentence, terminated by a frame with
     * `isFinal: true`. Appending every frame produces a stuttering, triplicated
     * feed. Instead we key on `messageId` and overwrite in place.
     *
     * The `isFinal` guard matters: RTM does not guarantee ordering, so a late
     * partial can arrive after its own final. Once a frame is final it is
     * frozen, and a straggling partial for that id is dropped.
     */
    case "TRANSCRIPT": {
      const incoming = action.payload;
      const at = state.transcripts.findIndex(
        (t) => t.messageId === incoming.messageId,
      );

      if (at === -1) {
        return {
          ...state,
          transcripts: [...state.transcripts, incoming].sort(
            (a, b) => a.at - b.at,
          ),
        };
      }

      if (state.transcripts[at].isFinal) return state;

      const transcripts = [...state.transcripts];
      transcripts[at] = { ...transcripts[at], ...incoming };
      return { ...state, transcripts };
    }

    case "BRIDGE": {
      const startedAt =
        action.state === "live" && state.startedAt === null
          ? (action.at ?? Date.now())
          : state.startedAt;

      return {
        ...state,
        bridge: action.state,
        startedAt,
        phase: action.state === "live" && state.phase === "standby"
          ? "triage"
          : state.phase,
      };
    }

    case "AGENT":
      return { ...state, agent: action.state };

    case "RTI":
      // Clamped defensively: RTI is computed remotely and a bad frame must not
      // be able to blow out the meter geometry.
      return { ...state, rti: Math.min(1, Math.max(0, action.value)) };

    case "TASK_STATUS":
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.id ? { ...t, status: action.status } : t,
        ),
      };

    case "APPROVAL_REQUEST":
      return { ...state, approval: action.payload };

    case "APPROVAL_RESOLVED":
      return { ...state, approval: null };

    case "RESOLVE_CONTRADICTION":
      return {
        ...state,
        contradictions: state.contradictions.map((c) =>
          c.id === action.id ? { ...c, resolved: true } : c,
        ),
      };

    case "RESET":
      return { ...initialIncidentState };

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Selectors — the Ledger projections (v6 §9.1)                                */
/* -------------------------------------------------------------------------- */

/**
 * The Ledger is ONE table discriminated by `epistemicStatus`. The UI presents
 * three panes, and these selectors are the projections over those same rows —
 * which is what makes "is this a fact or an assumption?" a query rather than a
 * convention that two separate arrays happen to follow.
 */

/**
 * Claims Echo may state aloud, with attribution: direct human measurements and
 * tool results. This is the "Established" pane.
 */
export const selectEstablished = (s: IncidentState): Claim[] =>
  s.claims.filter(
    (c) => c.epistemicStatus === "OBSERVED" || c.epistemicStatus === "TOOL_RESULT",
  );

/** Proposed causes. Echo may raise these only as open questions. */
export const selectHypotheses = (s: IncidentState): Claim[] =>
  s.claims.filter((c) => c.epistemicStatus === "HYPOTHESIS");

/**
 * Claims the extraction model derived rather than heard.
 *
 * Useful for laying out the graph, and rendered on the dashboard with a dashed
 * border and an explicit badge — but v6 §6.2 Rule 3 forbids them from ever
 * reaching the voice channel, and the Bridge Controller filters them out of
 * every payload so the model cannot route around it.
 */
export const selectInferences = (s: IncidentState): Claim[] =>
  s.claims.filter((c) => c.epistemicStatus === "INFERRED");

/** Ids of claims that some later claim has settled. */
export const selectSupersededIds = (s: IncidentState): Set<string> => {
  const ids = new Set<string>();
  for (const c of s.claims) if (c.supersedes) ids.add(c.supersedes);
  return ids;
};

/** A hypothesis nothing has settled yet. */
export const selectOpenHypotheses = (s: IncidentState): Claim[] => {
  const settled = selectSupersededIds(s);
  return selectHypotheses(s).filter((c) => !settled.has(c.id));
};

/* -------------------------------------------------------------------------- */
/* Selectors — obligations                                                     */
/* -------------------------------------------------------------------------- */

/** Contradictions still awaiting a human ruling — the console's alarm state. */
export const selectOpenContradictions = (s: IncidentState) =>
  s.contradictions.filter((c) => !c.resolved);

/** Everything still owed by somebody when the incident closes. */
export const selectOpenTasks = (s: IncidentState) =>
  s.tasks.filter((t) => t.status !== "DONE");

/**
 * What the close-out report must read out as unresolved (v6 W9): every
 * hypothesis nobody settled, plus every gap nobody covered. Echo states this
 * list and then says, explicitly, that root cause is not established.
 */
export const selectUnresolvedRisks = (s: IncidentState) => {
  const hypotheses = selectOpenHypotheses(s);
  return {
    hypotheses,
    unchecked: s.unchecked,
    count: hypotheses.length + s.unchecked.length,
  };
};

/** Resolve claim ids to claims — used to render a task's evidence chain. */
export const selectClaimsByIds = (s: IncidentState, ids?: string[]): Claim[] => {
  if (!ids?.length) return [];
  const byId = new Map(s.claims.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is Claim => Boolean(c));
};
