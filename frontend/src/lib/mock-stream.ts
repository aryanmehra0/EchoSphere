import type { IncidentAction } from "./incident-reducer";

/**
 * Scripted replay of Demo Script v2 (v6 §18), compressed to ~50s.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THROWAWAY CODE:
 *
 * Every frame below is a real `IncidentAction` — the identical object the
 * Phase 3 analytics WebSocket will dispatch. Nothing in the component tree can
 * tell the difference between this replay and a live incident. That gives us:
 *
 *   1. The Phase 1 UI is demonstrable end-to-end today, with no backend.
 *   2. The Slow Loop's output contract is pinned down and exercised BEFORE a
 *      line of Python is written.
 *   3. It is Tier 1 of the Rehearsal Rig (v6 §15) — recorded fixtures driving
 *      the pure reducer, running in CI on every commit.
 *
 * ── EPISTEMIC DISCIPLINE (v6 §6) ────────────────────────────────────────────
 * Every Echo line here is written against the three hard rules, and the test
 * suite enforces them:
 *
 *   Rule 1  Attribution is mandatory. Echo never states a claim without naming
 *           who established it and when.
 *   Rule 2  Causation is always interrogative. Echo never asserts X caused Y.
 *           It names inconsistencies and gaps, and hands judgment to humans.
 *   Rule 3  INFERRED claims never reach the voice channel. They render on the
 *           dashboard only, dashed and badged.
 *
 * The v5 version of this script had Echo say "That points to a network
 * partition... not a cache failure" and close with "Root cause: network
 * partition". v6 §6.3 tabulates both as violations of the brief — Echo was
 * diagnosing, which the problem statement explicitly forbids. The rewrite is
 * not merely more compliant; it is more useful, because it tells the room what
 * is known, who established it, and what nobody has checked.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Transcripts arrive as partial → final pairs sharing one `messageId`, so the
 * dedup path in the reducer is exercised on every run.
 */

export interface ScriptFrame {
  /** Milliseconds from the start of the replay. */
  at: number;
  action: IncidentAction;
}

/**
 * Shift a frame's relative timestamps onto the real wall clock.
 *
 * Every `at` in this file is an offset from the start of the replay, which
 * keeps the fixture readable and lets the reducer tests assert exact values.
 * The UI, though, formats `at` as a time of day — so replaying the raw script
 * stamps the whole incident at 00:00:04 on 1 January 1970.
 *
 * In Phase 3 the analytics loop sends absolute epoch times and this is simply
 * not called.
 */
export function rebaseAction(
  action: IncidentAction,
  epoch: number,
): IncidentAction {
  const shift = <T extends { at: number }>(items?: T[]) =>
    items?.map((i) => ({ ...i, at: epoch + i.at }));

  switch (action.type) {
    case "TRANSCRIPT":
      return {
        ...action,
        payload: { ...action.payload, at: epoch + action.payload.at },
      };

    case "DELTA": {
      const p = action.payload;
      return {
        ...action,
        payload: {
          ...p,
          claims: shift(p.claims),
          unchecked: shift(p.unchecked),
          tasks: shift(p.tasks),
          contradictions: shift(p.contradictions),
          timeline: shift(p.timeline),
        },
      };
    }

    default:
      return action;
  }
}

const UID = {
  devops: 1001,
  support: 1002,
  dba: 1003,
} as const;

/** Timestamps are relative; the driver rebases them onto the real join time. */
const t = (ms: number) => ms;

export const DEMO_SCRIPT: ScriptFrame[] = [
  /* --- Act 0 — the bridge opens ----------------------------------------- */
  { at: t(400), action: { type: "AGENT", state: "joining" } },
  { at: t(1600), action: { type: "AGENT", state: "listening" } },
  {
    at: t(1700),
    action: {
      type: "DELTA",
      payload: {
        phase: "triage",
        timeline: [
          {
            id: "tl-0",
            at: 0,
            kind: "signal",
            text: "Incident bridge opened. Echo joined as observer.",
            actor: "Echo",
          },
        ],
      },
    },
  },

  /* --- Act 1 — chaos ----------------------------------------------------- */
  {
    at: t(2600),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m1",
        uid: UID.devops,
        role: "DevOps Lead",
        text: "Everyone on the bridge — massive spike in 500s on checkout.",
        isFinal: false,
        at: 2600,
      },
    },
  },
  {
    at: t(3900),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m1",
        uid: UID.devops,
        role: "DevOps Lead",
        text:
          "Everyone on the bridge — massive spike in 500s on checkout. Latency is through the roof. Datadog looks like Redis might be evicting keys.",
        isFinal: true,
        at: 2600,
      },
    },
  },
  {
    at: t(4400),
    action: {
      type: "DELTA",
      payload: {
        entities: [
          {
            id: "clients",
            label: "Customer Sessions",
            kind: "client",
            status: "WARNING",
            detail: "web + mobile",
            position: { x: 0, y: 250 },
          },
          {
            id: "checkout",
            label: "Checkout Service",
            kind: "service",
            status: "CRITICAL",
            detail: "svc-checkout-v3",
            metric: "4.2k 5xx/min",
            position: { x: 306, y: 250 },
          },
        ],
        links: [
          {
            id: "l-clients-checkout",
            source: "clients",
            target: "checkout",
            label: "failed purchases",
            kind: "causal",
          },
        ],
        claims: [
          {
            id: "clm-5xx",
            text: "Checkout is returning 500s at roughly 4.2k per minute.",
            entity: "checkout",
            epistemicStatus: "OBSERVED",
            speakerRole: "DevOps Lead",
            confidence: 0.97,
            at: 4400,
          },
          // Note the status: "might be evicting" is a PROPOSED CAUSE. Nobody
          // has measured the cache. This is the distinction the demo stops to
          // point at, and most entries silently collapse it into "facts".
          {
            id: "clm-evict",
            text: "Redis may be evicting keys under memory pressure.",
            entity: "redis",
            epistemicStatus: "HYPOTHESIS",
            speakerRole: "DevOps Lead",
            confidence: 0.55,
            at: 4400,
          },
        ],
        timeline: [
          {
            id: "tl-1",
            at: 4400,
            kind: "signal",
            text: "5xx surge detected on checkout service.",
            actor: "DevOps Lead",
          },
        ],
        rti: 0.28,
      },
    },
  },
  {
    at: t(5600),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m2",
        uid: UID.support,
        role: "Support Engineer",
        text: "Tickets are flooding in.",
        isFinal: false,
        at: 5600,
      },
    },
  },
  {
    at: t(6900),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m2",
        uid: UID.support,
        role: "Support Engineer",
        text:
          "Tickets are flooding in. Users say their carts empty the second they hit purchase.",
        isFinal: true,
        at: 5600,
      },
    },
  },
  {
    at: t(7400),
    action: {
      type: "DELTA",
      payload: {
        entities: [
          {
            id: "redis",
            label: "Redis Primary",
            kind: "datastore",
            status: "WARNING",
            detail: "us-east-1a",
            metric: "unmeasured",
            position: { x: 648, y: 74 },
          },
          {
            id: "clients",
            label: "Customer Sessions",
            kind: "client",
            status: "CRITICAL",
            detail: "web + mobile",
            metric: "312 tickets",
            position: { x: 0, y: 250 },
          },
        ],
        links: [
          {
            id: "l-checkout-redis",
            source: "checkout",
            target: "redis",
            label: "unverified path",
            kind: "suspected",
          },
        ],
        claims: [
          {
            id: "clm-carts",
            text: "Customer carts empty at purchase confirmation.",
            entity: "clients",
            epistemicStatus: "OBSERVED",
            speakerRole: "Support Engineer",
            confidence: 0.93,
            at: 7400,
          },
        ],
        unchecked: [
          {
            id: "unc-cache-mem",
            description: "Nobody has measured Redis memory directly.",
            suggestedOwner: "DevOps Lead",
            at: 7400,
          },
        ],
        timeline: [
          {
            id: "tl-2",
            at: 7400,
            kind: "signal",
            text: "Cache eviction proposed — recorded as a hypothesis, not a fact.",
            actor: "Echo",
          },
        ],
        rti: 0.41,
      },
    },
  },

  /* --- Act 2 — the contradiction ---------------------------------------- */
  {
    at: t(9600),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m3",
        uid: UID.devops,
        role: "DevOps Lead",
        text: "Wait — I checked the primary Redis shard directly.",
        isFinal: false,
        at: 9600,
      },
    },
  },
  {
    at: t(10900),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m3",
        uid: UID.devops,
        role: "DevOps Lead",
        text:
          "Wait — I checked the primary Redis shard directly. Memory's at 40 percent. It's not eviction. The cache is fine.",
        isFinal: true,
        at: 9600,
      },
    },
  },
  {
    at: t(11800),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m4",
        uid: UID.support,
        role: "Support Engineer",
        text: "But application logs are definitely showing",
        isFinal: false,
        at: 11800,
      },
    },
  },
  {
    at: t(13000),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m4",
        uid: UID.support,
        role: "Support Engineer",
        text:
          "But application logs are definitely showing cache read timeouts. Network must be dropping packets.",
        isFinal: true,
        at: 11800,
      },
    },
  },
  { at: t(13600), action: { type: "RTI", value: 0.72 } },
  {
    at: t(13800),
    action: {
      type: "DELTA",
      payload: {
        claims: [
          {
            id: "clm-mem40",
            text: "Redis primary memory measured at 40 percent.",
            entity: "redis",
            epistemicStatus: "OBSERVED",
            speakerRole: "DevOps Lead",
            confidence: 0.96,
            at: 13800,
            // The measurement settles the eviction hypothesis.
            supersedes: "clm-evict",
            contradicts: ["clm-timeouts"],
          },
          {
            id: "clm-timeouts",
            text: "Application logs show sustained cache read timeouts.",
            entity: "redis",
            epistemicStatus: "OBSERVED",
            speakerRole: "Support Engineer",
            confidence: 0.94,
            at: 13800,
            contradicts: ["clm-mem40"],
          },
        ],
        contradictions: [
          {
            id: "cx1",
            claimA: "clm-mem40",
            claimB: "clm-timeouts",
            speakers: ["DevOps Lead", "Support Engineer"],
            resolved: false,
            at: 13800,
          },
        ],
        entities: [
          {
            id: "redis",
            label: "Redis Primary",
            kind: "datastore",
            status: "WARNING",
            detail: "us-east-1a",
            metric: "mem 40% — contested",
            position: { x: 648, y: 74 },
          },
        ],
        timeline: [
          {
            id: "tl-3",
            at: 13800,
            kind: "contradiction",
            text: "Two observations on the cache are in tension. Echo intervening.",
            actor: "Echo",
          },
        ],
        phase: "investigating",
      },
    },
  },
  { at: t(14400), action: { type: "AGENT", state: "thinking" } },
  { at: t(15600), action: { type: "AGENT", state: "speaking" } },
  {
    at: t(15700),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m5",
        uid: 0,
        role: "Echo",
        // Rule 1: both claims attributed, with times.
        // Rule 2: no causal assertion — it names the gap and asks who owns it.
        text:
          "Two observations on the cache. DevOps measured memory at 40 percent. Support reported read timeouts a minute later. Those are different properties, so both can be true — this is not a cache-capacity question. The network path between checkout and the cache has not been checked by anyone. Who owns that?",
        isFinal: true,
        at: 15700,
      },
    },
  },
  { at: t(21000), action: { type: "AGENT", state: "listening" } },
  {
    at: t(21600),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m6",
        uid: UID.devops,
        role: "DevOps Lead",
        text: "Good catch. I'll pull the VPC flow logs.",
        isFinal: true,
        at: 21600,
      },
    },
  },
  {
    at: t(22200),
    action: {
      type: "DELTA",
      payload: {
        entities: [
          {
            id: "netpath",
            label: "VPC us-east-1a",
            kind: "network",
            status: "UNKNOWN",
            detail: "us-east-1a",
            metric: "unchecked",
            position: { x: 648, y: 426 },
          },
        ],
        links: [
          {
            id: "l-checkout-net",
            source: "checkout",
            target: "netpath",
            label: "unverified path",
            kind: "suspected",
          },
        ],
        tasks: [
          {
            id: "task-1",
            assigneeRole: "DevOps Lead",
            description: "Pull VPC flow logs for us-east-1a.",
            status: "IN_PROGRESS",
            // v6 §9.4: the task is justified by the two claims in tension.
            evidence: ["clm-mem40", "clm-timeouts"],
            ref: "INC-4417-1",
            at: 22200,
          },
        ],
        unchecked: [
          {
            id: "unc-netpath",
            description:
              "The network path between checkout and the cache is unverified.",
            suggestedOwner: "DevOps Lead",
            at: 22200,
          },
        ],
        timeline: [
          {
            id: "tl-4",
            at: 22200,
            kind: "decision",
            text: "DevOps Lead took ownership of the unchecked network path.",
            actor: "DevOps Lead",
          },
        ],
      },
    },
  },

  /* --- Act 3 — tool result and the authorization gate --------------------- */
  { at: t(25000), action: { type: "RTI", value: 0.55 } },
  {
    at: t(25400),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m7",
        uid: UID.devops,
        role: "DevOps Lead",
        text: "Flow logs are back — 90 percent packet loss in us-east-1a.",
        isFinal: true,
        at: 25400,
      },
    },
  },
  {
    at: t(26000),
    action: {
      type: "DELTA",
      payload: {
        entities: [
          {
            id: "netpath",
            label: "VPC us-east-1a",
            kind: "network",
            status: "CRITICAL",
            detail: "us-east-1a",
            metric: "90% pkt loss",
            position: { x: 648, y: 426 },
          },
        ],
        links: [
          {
            id: "l-checkout-net",
            source: "checkout",
            target: "netpath",
            label: "90% packet loss",
            kind: "causal",
          },
        ],
        claims: [
          {
            id: "clm-pktloss",
            text: "Flow-log query returned 90 percent packet loss in us-east-1a.",
            entity: "netpath",
            epistemicStatus: "TOOL_RESULT",
            speakerRole: "DevOps Lead",
            confidence: 0.99,
            at: 26000,
            supersedes: "unc-netpath",
          },
          // INFERRED: the extraction model derived this. It lays out the graph
          // and it is shown on the dashboard, dashed and badged — but Rule 3
          // means it is filtered out of every Bridge payload and Echo can
          // never say it. This is the structural half of the fix.
          {
            id: "clm-inf-isolation",
            text: "Packet loss on this path would isolate checkout from the cache.",
            entity: "redis",
            epistemicStatus: "INFERRED",
            speakerRole: "Echo",
            confidence: 0.81,
            at: 26000,
          },
        ],
        tasks: [
          {
            id: "task-1",
            assigneeRole: "DevOps Lead",
            description: "Pull VPC flow logs for us-east-1a.",
            status: "DONE",
            evidence: ["clm-mem40", "clm-timeouts"],
            ref: "INC-4417-1",
            at: 22200,
          },
        ],
        timeline: [
          {
            id: "tl-5",
            at: 26000,
            kind: "signal",
            text: "Tool result recorded: 90% packet loss, us-east-1a.",
            actor: "DevOps Lead",
          },
        ],
        phase: "mitigating",
      },
    },
  },
  { at: t(26400), action: { type: "RESOLVE_CONTRADICTION", id: "cx1" } },
  { at: t(27000), action: { type: "AGENT", state: "speaking" } },
  {
    at: t(27100),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m8",
        uid: 0,
        role: "Echo",
        // Rule 1: attributed as a tool result. Rule 2: "That is evidence, not
        // a conclusion" — Echo explicitly declines to diagnose.
        text:
          "Recorded as a tool result: 90 percent packet loss in us-east-1a, reported by DevOps. That is evidence, not a conclusion. I have prepared a failover request to us-east-1b. It is a critical action — it needs your approval on the dashboard. I cannot authorise it from voice alone.",
        isFinal: true,
        at: 27100,
      },
    },
  },
  {
    at: t(27300),
    action: {
      type: "DELTA",
      payload: {
        tasks: [
          {
            id: "task-2",
            assigneeRole: "DevOps Lead",
            description: "Approve failover request to us-east-1b.",
            status: "BLOCKED",
            evidence: ["clm-pktloss", "clm-timeouts"],
            ref: "RUNBOOK-77",
            at: 27300,
          },
        ],
      },
    },
  },
  { at: t(31500), action: { type: "AGENT", state: "listening" } },
  {
    at: t(32100),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m9",
        uid: UID.devops,
        role: "DevOps Lead",
        text: "Yes, do it.",
        isFinal: true,
        at: 32100,
      },
    },
  },
  {
    at: t(32700),
    action: {
      type: "DELTA",
      payload: {
        timeline: [
          {
            id: "tl-6",
            at: 32700,
            kind: "signal",
            // The whole point of G7: voice is logged as intent, never as
            // authorization. Nothing executes here.
            text: "Verbal assent logged as intent. Awaiting dashboard approval.",
            actor: "Echo",
          },
        ],
      },
    },
  },
  {
    at: t(34500),
    action: {
      type: "DELTA",
      payload: {
        entities: [
          {
            id: "redis-b",
            label: "Redis Replica",
            kind: "datastore",
            status: "OK",
            detail: "us-east-1b",
            metric: "promoted",
            position: { x: 990, y: 250 },
          },
        ],
        links: [
          {
            id: "l-redis-redisb",
            source: "redis",
            target: "redis-b",
            label: "failover to",
            kind: "depends",
          },
        ],
        tasks: [
          {
            id: "task-2",
            assigneeRole: "DevOps Lead",
            description: "Approve failover request to us-east-1b.",
            status: "DONE",
            evidence: ["clm-pktloss", "clm-timeouts"],
            ref: "RUNBOOK-77",
            at: 27300,
          },
          {
            id: "task-3",
            assigneeRole: "Database Admin",
            description: "Check replica lag before re-promoting us-east-1a.",
            status: "OPEN",
            evidence: ["clm-pktloss"],
            ref: "INC-4417-3",
            at: 34500,
          },
        ],
        timeline: [
          {
            id: "tl-7",
            at: 34500,
            kind: "decision",
            text: "Failover approved on dashboard by DevOps Lead (UID 1001).",
            actor: "DevOps Lead",
          },
        ],
      },
    },
  },
  { at: t(35200), action: { type: "AGENT", state: "speaking" } },
  {
    at: t(35300),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m10",
        uid: 0,
        role: "Echo",
        text:
          "Filed as INC-4417-A. Platform on-call notified. No infrastructure was changed by me — a human executes the failover.",
        isFinal: true,
        at: 35300,
      },
    },
  },
  { at: t(39000), action: { type: "AGENT", state: "listening" } },

  /* --- Act 4 — close-out -------------------------------------------------- */
  {
    at: t(39600),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m11",
        uid: UID.support,
        role: "Support Engineer",
        text: "Echo, close the incident and summarise.",
        isFinal: true,
        at: 39600,
      },
    },
  },
  { at: t(40200), action: { type: "RTI", value: 0.22 } },
  {
    at: t(40400),
    action: {
      type: "DELTA",
      payload: {
        entities: [
          {
            id: "checkout",
            label: "Checkout Service",
            kind: "service",
            status: "OK",
            detail: "svc-checkout-v3",
            metric: "5xx → 0",
            position: { x: 306, y: 250 },
          },
          {
            id: "clients",
            label: "Customer Sessions",
            kind: "client",
            status: "OK",
            detail: "web + mobile",
            metric: "recovering",
            position: { x: 0, y: 250 },
          },
          // Stays amber ON PURPOSE — nobody ever explained why the path
          // degraded. v6 §18 Act 4 makes this the closing line of the pitch.
          {
            id: "netpath",
            label: "VPC us-east-1a",
            kind: "network",
            status: "WARNING",
            detail: "us-east-1a",
            metric: "unexplained",
            position: { x: 648, y: 426 },
          },
          // The conflict was adjudicated — both claims stood — so "contested"
          // is no longer true. It stays amber because traffic moved to 1b and
          // nobody re-verified the primary, which is a different open question.
          {
            id: "redis",
            label: "Redis Primary",
            kind: "datastore",
            status: "WARNING",
            detail: "us-east-1a",
            metric: "superseded by 1b",
            position: { x: 648, y: 74 },
          },
        ],
        claims: [
          {
            id: "clm-recovered",
            text: "Checkout latency and error rate returned to baseline.",
            entity: "checkout",
            epistemicStatus: "OBSERVED",
            speakerRole: "DevOps Lead",
            confidence: 0.96,
            at: 40400,
          },
        ],
        unchecked: [
          {
            id: "unc-why-degraded",
            description: "Nobody established why the network path degraded.",
            suggestedOwner: "DevOps Lead",
            at: 40400,
          },
        ],
        timeline: [
          {
            id: "tl-8",
            at: 40400,
            kind: "resolution",
            text: "Checkout recovered. Root cause NOT established.",
            actor: "Echo",
          },
        ],
        phase: "resolved",
      },
    },
  },
  { at: t(41000), action: { type: "AGENT", state: "speaking" } },
  {
    at: t(41100),
    action: {
      type: "TRANSCRIPT",
      payload: {
        messageId: "m12",
        uid: 0,
        role: "Echo",
        // The close-out v6 §18 Act 4 requires: everything established WITH its
        // source, everything unresolved, and the explicit refusal to name a
        // root cause.
        text:
          "Open 14 minutes. Established: checkout 5xx elevated, reported by DevOps; Redis memory measured normal by DevOps; cache read timeouts observed by Support; 90 percent packet loss returned by the flow-log query. Action: failover request filed and approved by DevOps Lead on the dashboard. Two items unresolved. One, nobody established why the network path degraded. Two, the DBA's replica-lag check is still open. Root cause is not established. I have drafted the post-mortem with every claim, its source and its timestamp attached.",
        isFinal: true,
        at: 41100,
      },
    },
  },
  { at: t(48000), action: { type: "AGENT", state: "listening" } },
];

/** Total runtime of the replay, in ms. */
export const DEMO_DURATION = DEMO_SCRIPT[DEMO_SCRIPT.length - 1].at + 2000;
