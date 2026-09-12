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
 * are the functional identity the analytics loop sees.
 */
export type ParticipantRole =
  | "Incident Commander"
  | "Communications Lead"
  | "DevOps Lead"
  | "Site Reliability Engineer"
  | "Database Admin"
  | "Backend Engineer"
  | "Security Engineer"
  | "Network Engineer"
  | "Support Engineer"
  | "Observer"
  | "Echo"
  | "Datadog APM"
  | "Prometheus"
  | "CloudWatch"
  | "Telemetry Probe"
  | (string & {});

export type UserPermission =
  | "APPROVE_CRITICAL_ACTIONS"
  | "MINT_TIMELINE_DECISIONS"
  | "MANAGE_INCIDENT_STATE"
  | "SPEAK_ON_BRIDGE";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  defaultRole: ParticipantRole;
  permissions: UserPermission[];
  avatarUrl?: string;
}

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
export type ClaimLifecycle = "ACTIVE" | "STALE" | "SUPERSEDED" | "REFUTED";

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
  validFrom?: number;
  validUntil?: number | null;
  ttlSeconds?: number | null;
  lifecycle?: ClaimLifecycle;
  speakerName?: string;
  speakerUserId?: string;
}

/** Status of a spoken engineering hypothesis in the elimination matrix. */
export type HypothesisStatus = "OPEN" | "REFUTED" | "CORROBORATED";

export interface HypothesisMatrixItem {
  hypothesis: Claim;
  status: HypothesisStatus;
  evidenceClaim?: Claim;
  reason?: string;
  suggestedProbe?: {
    entity: string;
    metric?: string;
    label: string;
    provider?: string;
  };
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
  aliases?: string[];
};

export interface IncidentLink {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: EdgeKind;
}

/** Read-only telemetry measurement point returned by active probes. */
export interface TelemetryReading {
  entityId: string;
  entityLabel: string;
  metricName: string;
  value: number;
  unit: string;
  status: EntityStatus;
  provider: "Datadog APM" | "Prometheus" | "CloudWatch" | string;
  timestamp: number;
  formatted: string;
  threshold?: number | null;
  rawPayload?: Record<string, unknown>;
}

/** Pre-hydrated incident scenario for live demonstration and exploration. */
export interface Scenario {
  id: string;
  name: string;
  description: string;
  badge: string;
  entities: IncidentEntity[];
  links: IncidentLink[];
  initialClaims?: Claim[];
}

/* -------------------------------------------------------------------------- */
/* Enterprise Project Workspace & Observability Connectors                    */
/* -------------------------------------------------------------------------- */

export type ConnectorProvider =
  | "prometheus"
  | "datadog"
  | "cloudwatch"
  | "grafana_loki"
  | "slack";

export type ConnectorStatus =
  | "CONNECTED"
  | "CONFIGURED"
  | "UNCONFIGURED"
  | "ERROR";

export interface ConnectorConfig {
  provider: ConnectorProvider;
  name: string;
  status: ConnectorStatus;
  endpoint: string;
  authMasked?: string;
  region?: string | null;
  serviceFilter?: string | null;
  latencyMs?: number | null;
  lastTestedAt?: number | null;
  errorMessage?: string | null;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: ParticipantRole | string;
  isOnline: boolean;
  permissions?: UserPermission[] | string[];
}

export interface IncidentChannelSummary {
  id: string;
  title: string;
  severity: number;
  status: string;
  channel: string;
  startedAt: number;
}

export interface ProjectWorkspace {
  id: string;
  slug: string;
  name: string;
  description: string;
  environment: string;
  team: ProjectMember[];
  connectors: Record<string, ConnectorConfig>;
  activeIncidents: IncidentChannelSummary[];
  connectedCount?: number;
  memberCount?: number;
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
 * One analyst's independent read of a pair — §7a.
 *
 * Kept verbatim rather than summarised, because the whole value of the panel
 * is that a human can see WHERE the judgement was contested.
 */
export interface PanelPosition {
  persona: string;
  model: string;
  relation: string;
  confidence: number;
  why: string;
  whyOtherFailed?: string;
}

/**
 * How the Deliberation Panel reached a verdict.
 *
 * `dissent` is the field that earns this its screen space: a conflict two
 * analysts disagreed about is a weaker signal than a unanimous one, and a
 * human acting on it deserves to know which they are looking at. Hiding it
 * would be the same error as collapsing HYPOTHESIS into OBSERVED — Echo
 * presenting its own uncertainty as settled.
 */
export interface PanelDeliberation {
  relation: string;
  confidence: number;
  why: string;
  dissent: boolean;
  whyOtherFailed?: string;
  positions: PanelPosition[];
}

/**
 * Whether Echo is minuting the bridge — §10.5.
 *
 * Surfaced prominently rather than tucked into a settings panel. A recording
 * state nobody can see is worse than no control at all, because people will
 * believe whichever state they assumed; the one thing worse than recording
 * someone who did not expect it is convincing them you stopped when you had
 * not. `suspendedTurns` is a COUNT — the dropped text is never sent, stored,
 * or logged anywhere.
 */
export interface PrivacyState {
  recording: boolean;
  suspendedTurns: number;
  /** Epoch ms the current pause began; null while recording. */
  since: number | null;
  /** The role that last flipped it — attribution applies here too. */
  changedBy: string | null;
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
  /** The adjudicated relation — OPPOSED, INDEPENDENT, AGREES, REFINES. */
  relation?: string;
  why?: string;
  /** Absent when the verdict came from the pre-panel single judge. */
  panel?: PanelDeliberation;
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
  actorName?: string;
  actorUserId?: string;
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
  speakerName?: string;
  speakerUserId?: string;
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

/**
 * What is currently broken — v6 §13.
 *
 * Surfaced rather than swallowed. A system quietly running degraded is worse
 * than one that has obviously failed, because the operator keeps trusting
 * output that is no longer complete.
 */
export interface Degradation {
  voice: boolean;
  extraction: boolean;
  model: string | null;
  /** One short line naming the CONSEQUENCE, for the command bar. */
  banner: string | null;
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

  projectId?: string;
  projectName?: string;

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

  /** Null when everything is healthy. */
  degraded: Degradation | null;

  /** Whether the bridge is being minuted at all — §10.5. */
  privacy: PrivacyState;
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
  degraded?: Degradation | null;
  privacy?: PrivacyState;
}

/** Participant presence item displayed in the War Room Roster. */
export interface RosterParticipant {
  uid: number;
  role: ParticipantRole;
  kind: "human" | "agent" | "observer";
  authorized: boolean;
  issuedAt: number;
  userId?: string;
  name?: string;
  permissions?: UserPermission[];
  isSpeaking?: boolean;
}

export interface PostMortemClaim {
  id?: string;
  text: string;
  speakerRole?: string;
  speakerName?: string | null;
  speakerUserId?: string | null;
  confidence?: number;
  entity?: string | null;
  formattedTime?: string;
  lifecycle?: string;
}

export interface PostMortemContradiction {
  id: string;
  speakers?: string[];
  relation?: string;
  why?: string;
  resolved?: boolean;
  claims?: string[];
}

export interface PostMortemTask {
  id: string;
  description: string;
  assigneeRole: string;
  status: string;
  ref?: string | null;
  at: number;
}

/** Structured post-mortem report and markdown export. */
export interface PostMortemResponse {
  postmortem: {
    overview: {
      incidentId: string;
      channel: string;
      phase: string;
      startedAt: number;
      startedAtFormatted: string;
      closedAt: number;
      closedAtFormatted: string;
      duration: string;
      peakRti: number;
      status: string;
    };
    entities: Array<{
      id: string;
      label: string;
      kind: string;
      status: string;
      metric?: string | null;
      aliases?: string[];
    }>;
    timeline: Array<{
      id: string;
      kind: string;
      text: string;
      actor: string;
      actorName?: string | null;
      actorUserId?: string | null;
      at: number;
      formattedTime: string;
    }>;
    epistemicClaims: {
      observed: PostMortemClaim[];
      hypothesis: PostMortemClaim[];
      inferred: PostMortemClaim[];
      refutedOrStale: PostMortemClaim[];
    };
    contradictions: PostMortemContradiction[];
    tasks: PostMortemTask[];
    auditLog: Array<{
      at: number;
      formattedTime: string;
      actorUid: number | null;
      actorName?: string | null;
      actorUserId?: string | null;
      action: string;
      outcome: string;
      detail: string;
    }>;
    privacy: Record<string, unknown>;
    epistemicNeutralityDisclaimer: string;
  };
  markdown: string;
}

