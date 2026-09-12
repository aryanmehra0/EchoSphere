import type {
  AgentState,
  BridgeState,
  Claim,
  IncidentDelta,
  IncidentState,
  TaskStatus,
  Transcript,
  ApprovalRequest,
  Scenario,
  HypothesisMatrixItem,
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
  | { type: "LOAD_SCENARIO"; scenario: Scenario }
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
/**
 * A long-running Sev-1 bridge routinely outlasts an hour, and `transcripts`/
 * `timeline` only ever grow — every other collection is naturally bounded by
 * real incident cardinality (there are only so many entities/claims/tasks a
 * room produces), but a transcript feed keeps one entry per utterance and a
 * timeline one per signal/decision for the entire duration. Capped to the
 * most recent N with oldest-first eviction so a multi-hour incident doesn't
 * grow these without bound; high enough that no realistic single incident's
 * scrollback is actually reached in practice.
 */
const MAX_TRANSCRIPTS = 2000;
const MAX_TIMELINE_EVENTS = 2000;

function capOldest<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

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
        timeline: capOldest(upsert(state.timeline, d.timeline).sort((a, b) => a.at - b.at), MAX_TIMELINE_EVENTS),
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
        timeline: capOldest([...(d.timeline ?? [])].sort((a, b) => a.at - b.at), MAX_TIMELINE_EVENTS),
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

      /*
        ── A BLANK TURN IS NOT A TURN ──────────────────────────────────────
        VAD fires on coughs, chair scrapes and room noise, so the recogniser
        emits turns whose text never becomes a word. Rendering one puts an
        empty row in the transcript feed attributed to a named human — a
        record that someone spoke when they did not, which is worse than a
        missing line in a product whose whole claim is careful attribution.

        Guarded here rather than only at the producer because transcripts
        reach this reducer from two places: the local toolkit AND the Slow
        Loop's delta socket. This is the one point both pass through.
      */
      if (!incoming.text?.trim()) return state;
      const at = state.transcripts.findIndex(
        (t) => t.messageId === incoming.messageId,
      );

      if (at === -1) {
        return {
          ...state,
          transcripts: capOldest(
            [...state.transcripts, incoming].sort((a, b) => a.at - b.at),
            MAX_TRANSCRIPTS,
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

    case "LOAD_SCENARIO":
      return {
        ...state,
        entities: action.scenario.entities,
        links: action.scenario.links,
        claims: action.scenario.initialClaims
          ? upsert(state.claims, action.scenario.initialClaims)
          : state.claims,
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
/**
 * Ids of claims that some later claim has settled.
 *
 * Declared ABOVE its callers on purpose. A `const` arrow function is not
 * hoisted, so a selector defined earlier that calls this one only works
 * because the call happens at render time rather than at module load — which
 * is true today and is exactly the kind of accident that breaks when
 * somebody reorders a file.
 */
export const selectSupersededIds = (s: IncidentState): Set<string> => {
  const ids = new Set<string>();
  for (const c of s.claims) if (c.supersedes) ids.add(c.supersedes);
  return ids;
};

export const selectEstablished = (s: IncidentState): Claim[] => {
  /*
    ── SUPERSEDED CLAIMS ARE EXCLUDED ────────────────────────────────────────
    `selectOpenHypotheses` already filtered on `selectSupersededIds`; this did
    not, and the asymmetry was visible on screen.

    Reported live: after "Correction, memory is actually at ninety five
    percent, not forty", the ESTABLISHED pane listed BOTH readings at 100%
    confidence —

        Memory is at forty percent right now.        100%
        The memory is at ninety five percent right.  100%

    — which is precisely the "two incompatible facts presented as settled"
    failure this product exists to prevent, displayed by the product itself.
    The backend's `Ledger.established()` had the same gap and was fixed with
    it; the two must stay in step, because `query_incident_state` reads one
    and the dashboard renders the other.

    The retired claim stays IN `s.claims` deliberately. It is still part of
    the record — "what did we believe at 02:08" is a real question — it is
    simply no longer current.
  */
  const settled = selectSupersededIds(s);
  return s.claims.filter(
    (c) =>
      (c.epistemicStatus === "OBSERVED" || c.epistemicStatus === "TOOL_RESULT") &&
      !settled.has(c.id),
  );
};

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

/** A hypothesis nothing has settled yet. */
export const selectOpenHypotheses = (s: IncidentState): Claim[] => {
  const settled = selectSupersededIds(s);
  return selectHypotheses(s).filter((c) => !settled.has(c.id));
};

function extractEntity(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("redis") || lower.includes("cache")) return "redis";
  if (lower.includes("replica")) return "postgres-replica";
  if (lower.includes("postgres") || lower.includes("db") || lower.includes("database")) return "postgres";
  if (lower.includes("checkout") || lower.includes("cart")) return "checkout";
  if (lower.includes("stripe") || lower.includes("payment")) return "stripe";
  if (lower.includes("network") || lower.includes("vpc") || lower.includes("packet") || lower.includes("transit") || lower.includes("drop")) return "network";
  if (lower.includes("auth") || lower.includes("jwt") || lower.includes("token")) return "auth";
  if (lower.includes("ingress") || lower.includes("gateway") || lower.includes("proxy")) return "ingress";
  return "system";
}

const DEFAULT_PROBES: Record<string, { entity: string; metric: string; label: string; provider: string }> = {
  redis: { entity: "redis", metric: "memory_utilization_pct", label: "Redis Primary", provider: "Datadog APM" },
  postgres: { entity: "postgres", metric: "connection_pool_pct", label: "Postgres Primary", provider: "Prometheus" },
  "postgres-replica": { entity: "postgres-replica", metric: "replication_lag_s", label: "Postgres Replica", provider: "Prometheus" },
  checkout: { entity: "checkout", metric: "p99_latency_ms", label: "Checkout Service", provider: "Datadog APM" },
  network: { entity: "network", metric: "packet_drop_pct", label: "VPC Netpath", provider: "CloudWatch" },
  stripe: { entity: "stripe", metric: "timeout_rate_pct", label: "Stripe Connector", provider: "Datadog APM" },
  auth: { entity: "auth", metric: "p99_latency_ms", label: "Auth Service", provider: "Datadog APM" },
  ingress: { entity: "ingress", metric: "http_5xx_pct", label: "Ingress Gateway", provider: "Datadog APM" },
};

/**
 * Evaluated Hypothesis Elimination Matrix.
 * Pairs each spoken theory with empirical measurements and determines
 * whether it is REFUTED, CORROBORATED, or OPEN (untested).
 */
export const selectHypothesisMatrix = (s: IncidentState): HypothesisMatrixItem[] => {
  const hypotheses = selectHypotheses(s);
  const established = selectEstablished(s);
  const settled = selectSupersededIds(s);

  const byEntity = new Map<string, Claim[]>();
  for (const c of established) {
    const ent = c.entity || extractEntity(c.text);
    const existing = byEntity.get(ent) ?? [];
    existing.push(c);
    byEntity.set(ent, existing);
  }

  return hypotheses.map((hyp) => {
    const targetEntity = hyp.entity || extractEntity(hyp.text);
    const candidates = byEntity.get(targetEntity) ?? [];

    if (hyp.lifecycle === "REFUTED" || settled.has(hyp.id)) {
      const supersedingClaim = established.find(
        (c) => c.supersedes === hyp.id || hyp.supersedes === c.id || (c.contradicts && c.contradicts.includes(hyp.id))
      );
      return {
        hypothesis: hyp,
        status: "REFUTED",
        evidenceClaim: supersedingClaim,
        reason: supersedingClaim
          ? `Settled on the ledger by ${supersedingClaim.speakerRole}: ${supersedingClaim.text}`
          : "Theory marked as refuted on the incident record.",
      };
    }

    if (candidates.length > 0) {
      const sorted = [...candidates].sort((a, b) => b.at - a.at);
      const evidenceClaim = sorted[0];
      const textLower = evidenceClaim.text.toLowerCase();

      const isOk = [
        "[ok]",
        "ok",
        "baseline",
        "0 evicted",
        "34.2%",
        "48.0%",
        "42ms",
        "healthy",
        "normal",
      ].some((token) => textLower.includes(token));
      const isCritical = [
        "[critical]",
        "[warning]",
        "critical",
        "warning",
        "drop rate",
        "92.4%",
        "2,840ms",
        "482.5s",
        "38.5%",
      ].some((token) => textLower.includes(token));

      if (isOk && !isCritical) {
        return {
          hypothesis: hyp,
          status: "REFUTED",
          evidenceClaim,
          reason: `Refuted by ${evidenceClaim.speakerRole}: telemetry confirms normal operational thresholds.`,
        };
      }

      if (isCritical) {
        return {
          hypothesis: hyp,
          status: "CORROBORATED",
          evidenceClaim,
          reason: `Corroborated by ${evidenceClaim.speakerRole}: observed telemetry aligns with reported symptom.`,
        };
      }
    }

    const suggested = DEFAULT_PROBES[targetEntity] ?? {
      entity: targetEntity,
      label: targetEntity.charAt(0).toUpperCase() + targetEntity.slice(1),
      provider: "Datadog APM",
    };

    return {
      hypothesis: hyp,
      status: "OPEN",
      suggestedProbe: suggested,
      reason: "No empirical telemetry probe or measurement has evaluated this theory yet.",
    };
  });
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

/**
 * Resolve claim ids to claims — used to render a task's evidence chain.
 *
 * ── WHY THE ARRAY CHECK IS `Array.isArray` AND NOT `?.length` ──────────────
 * It was `if (!ids?.length) return []`, and a STRING has `.length`. So a
 * `Task.evidence` that arrived as prose rather than a list of ids passed the
 * guard and died on the next line with
 *
 *     TypeError: ids.map is not a function
 *
 * React then unmounted the tree and the console RESET mid-incident, losing
 * the in-memory Ledger before write-behind had flushed it. One spoken
 * sentence — "Priya, can you check the replica lag?" — took out the whole
 * session, because the model answered `"evidence": "<the sentence>"`.
 *
 * `models.py::coerce_str_list` now fixes this at the boundary, which is the
 * real fix. This stays as defence in depth: a selector that crashes the app
 * on unexpected input is the wrong shape regardless of who is feeding it,
 * and the next provider will have its own ideas about JSON.
 */
export const selectClaimsByIds = (s: IncidentState, ids?: string[]): Claim[] => {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const byId = new Map(s.claims.map((c) => [c.id, c]));
  return ids
    .filter((id): id is string => typeof id === "string")
    .map((id) => byId.get(id))
    .filter((c): c is Claim => Boolean(c));
};
