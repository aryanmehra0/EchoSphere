/**
 * Domain model for the incident console.
 *
 * These types are the CONTRACT between the Slow Loop (Python analytics, Phase 3)
 * and this UI. They mirror the extraction schema in
 * `docs/echosphere_architecture_v6.md` §9.4 field-for-field, so that when the
 * WebSocket lands the payload deserialises straight into this shape with no
 * adapter layer.
 *
 * Rule: nothing in `components/` may invent its own shape for incident data.
 * If the UI needs a new field, it is added here first and the extraction prompt
 * is updated to match.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** Health of an infrastructure entity on the knowledge graph. */
export type EntityStatus = "CRITICAL" | "WARNING" | "OK" | "UNKNOWN";

/** Nature of a causal link between two entities. */
export type EdgeKind = "causal" | "suspected" | "depends";

/** Lifecycle of an action item. Mirrors the Jira states we sync to. */
export type TaskStatus = "OPEN" | "IN_PROGRESS" | "BLOCKED" | "DONE";

/** What class of thing an entity is — drives the node glyph on the canvas. */
export type EntityKind =
  | "service"
  | "datastore"
  | "network"
  | "gateway"
  | "region"
  | "client";

/**
 * Roles are assigned at token generation by the Roster Service (v6 §4.2) and
 * are the ONLY identity the analytics loop ever sees.
 */
export type ParticipantRole =
  | "DevOps Lead"
  | "Support Engineer"
  | "Database Admin"
  | "Echo";

/* -------------------------------------------------------------------------- */
/* Epistemic layer — v6 §6                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The load-bearing field of the whole architecture (v6 §6.1).
 *
 * The problem statement's final clause forbids Echo from "pretending to
 * independently determine the root cause". v6 makes that a property of the DATA
 * rather than a hope about phrasing, and this union is the mechanism:
 *
 *   OBSERVED     A human reported a direct measurement.   Echo may say it, WITH attribution.
 *   TOOL_RESULT  A queried tool returned it.              Echo may say it, WITH attribution.
 *   HYPOTHESIS   Someone proposed a cause.                Echo may raise it, AS AN OPEN QUESTION.
 *   INFERRED     The extraction LLM derived it.           Echo may NEVER say it. Dashboard only.
 *
 * INFERRED is the structural half of the fix: the Bridge Controller filters
 * these out of every payload, so the model cannot route around the rule because
 * inferred claims never enter its context in the first place.
 */
export type EpistemicStatus =
  | "OBSERVED"
  | "TOOL_RESULT"
  | "HYPOTHESIS"
  | "INFERRED";

/**
 * The unit of record in the Evidence Ledger.
 *
 * v6 §9.1 collapses v5's separate `facts` and `hypotheses` arrays into this one
 * table, discriminated by `epistemicStatus`. That is what turns the
 * fact-versus-assumption separation the problem statement demands into a
 * QUERY rather than a naming convention two arrays happen to follow.
 *
 * The UI still presents them as distinct panes — see the selectors in
 * `incident-reducer.ts`, which are projections over these same rows.
 */
export interface Claim {
  id: string;
  text: string;
  /** The graph entity this claim is about, when it is about one. */
  entity?: string;
  epistemicStatus: EpistemicStatus;
  /** Attribution. Mandatory — v6 §6.2 Rule 1: a claim without a source is not sayable. */
  speakerRole: ParticipantRole;
  confidence: number;
  at: number;
  /** Set when a later claim settles this one, e.g. a measurement closing a hypothesis. */
  supersedes?: string | null;
  /** Claim ids this one is in tension with, populated by the adjudicator. */
  contradicts?: string[];
}

/**
 * Something the conversation has NOT established — v6 §9.4.
 *
 * This is how requirement 5 (detection of *missing* information) becomes a
 * first-class output instead of an emergent hope. The extraction prompt asks
 * the model explicitly to name the gaps, and this list is what lets Echo say
 * "nobody has checked the network path" — which is the demo's strongest beat
 * precisely because it is not a diagnosis.
 */
export interface Unchecked {
  id: string;
  description: string;
  suggestedOwner?: ParticipantRole;
  at: number;
}

/* -------------------------------------------------------------------------- */
/* Graph                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Declared as a `type` rather than an `interface` on purpose: React Flow
 * constrains node data to `Record<string, unknown>`, and TypeScript grants an
 * implicit index signature to type aliases of object literals but never to
 * interfaces. Making this an interface forces a cast at every graph boundary.
 */
export type IncidentEntity = {
  id: string;
  label: string;
  kind: EntityKind;
  status: EntityStatus;
  /** Short qualifier shown beneath the label, e.g. "us-east-1a". */
  detail?: string;
  /** Free-form metric the analytics loop attaches, e.g. "94% pkt loss". */
  metric?: string;
  /** Layout hint. Absent for entities the LLM discovers mid-incident. */
  position?: { x: number; y: number };
};

export interface IncidentLink {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: EdgeKind;
}

/* -------------------------------------------------------------------------- */
/* Obligations                                                                 */
/* -------------------------------------------------------------------------- */

export interface Task {
  id: string;
  assigneeRole: ParticipantRole;
  description: string;
  status: TaskStatus;
  /**
   * Claim ids justifying this task — v6 §9.4.
   *
   * Makes "why are we doing this?" answerable at close-out, and is what the
   * Authorization Gate modal displays as the evidence chain before a human
   * approves a critical action.
   */
  evidence?: string[];
  /** External ticket reference once the Proxy Action Layer has filed it. */
  ref?: string;
  at: number;
}

/**
 * Two claims the Semantic Contradiction Engine found to be in tension.
 * `claimA`/`claimB` are claim IDs — v6 §9.2 sends references, not copies, so
 * the ledger stays the single source of truth for the text.
 */
export interface Contradiction {
  id: string;
  claimA: string;
  claimB: string;
  speakers: ParticipantRole[];
  resolved: boolean;
  at: number;
}

export type TimelineKind =
  | "signal"
  | "decision"
  | "action"
  | "contradiction"
  | "resolution";

export interface TimelineEvent {
  id: string;
  at: number;
  kind: TimelineKind;
  text: string;
  actor: ParticipantRole;
}

/* -------------------------------------------------------------------------- */
/* Voice                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One RTM transcript frame.
 *
 * `messageId` is the deduplication key: the Agora RTM stream emits the same
 * id repeatedly with a growing `text` as the utterance is transcribed, then
 * once more with `isFinal`. The reducer overwrites in place on that key, which
 * is what stops the transcript pane from stuttering.
 */
export interface Transcript {
  messageId: string;
  uid: number;
  role: ParticipantRole;
  text: string;
  isFinal: boolean;
  at: number;
}

/**
 * A CRITICAL action waiting on a human — v6 §10.2.
 *
 * Voice is an intent signal; THIS is the authorization. The nonce is single
 * use, expires in 120s, and is bound to `args` by a hash, so an approval for
 * one action cannot be redeemed for another.
 */
export interface ApprovalRequest {
  nonce: string;
  actionId: string;
  action: string;
  args: Record<string, unknown>;
  requiredRole: ParticipantRole | string;
  issuedAt: number;
  expiresAt: number;
  /** The claims justifying it. A human approves against the record, not
   *  against Echo's summary of the record. */
  evidence?: Claim[];
}

/** Connection lifecycle of the local RTC client. */
export type BridgeState = "idle" | "connecting" | "live" | "closing";

/** What Echo is doing right now, driven by the Fast Loop. */
export type AgentState = "offline" | "joining" | "listening" | "thinking" | "speaking";

/* -------------------------------------------------------------------------- */
/* Root state                                                                  */
/* -------------------------------------------------------------------------- */

export type IncidentPhase =
  | "standby"
  | "triage"
  | "investigating"
  | "mitigating"
  | "resolved";

export interface IncidentState {
  id: string;
  title: string;
  severity: 1 | 2 | 3;
  phase: IncidentPhase;
  /** Epoch ms the bridge opened; null until the operator joins. */
  startedAt: number | null;

  bridge: BridgeState;
  agent: AgentState;

  /**
   * Room Tension Index, 0–1. Computed server-side with EWMA and hysteresis
   * (v6 §8). The client NEVER derives this — it only renders it.
   */
  rti: number;

  entities: IncidentEntity[];
  links: IncidentLink[];
  /** The Evidence Ledger. One table, four epistemic statuses. */
  claims: Claim[];
  /** What nobody has established yet. */
  unchecked: Unchecked[];
  tasks: Task[];
  contradictions: Contradiction[];
  timeline: TimelineEvent[];
  transcripts: Transcript[];

  /** The pending CRITICAL action, if one is awaiting a human. */
  approval: ApprovalRequest | null;
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A delta pushed over the Phase 3 WebSocket. Every field is optional and
 * ADDITIVE — the analytics loop sends only what changed, which keeps the
 * payload small enough to survive a long incident.
 *
 * Phase 3 wraps this in a sequenced envelope (`{ seq, at, kind, payload }`,
 * v6 §9.2) so the dashboard can recover after a reload. The reducer merges by
 * `id` and is therefore idempotent, which is what lets the Delta Hub choose
 * REPLAY or SNAPSHOT freely without the client reconciling anything.
 */
export interface IncidentDelta {
  entities?: IncidentEntity[];
  links?: IncidentLink[];
  claims?: Claim[];
  unchecked?: Unchecked[];
  tasks?: Task[];
  contradictions?: Contradiction[];
  timeline?: TimelineEvent[];
  rti?: number;
  phase?: IncidentPhase;
  agent?: AgentState;
}
