import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  incidentReducer,
  initialIncidentState,
  selectEstablished,
  selectHypotheses,
  selectInferences,
  selectOpenContradictions,
  selectOpenHypotheses,
  selectOpenTasks,
  selectUnresolvedRisks,
  type IncidentAction,
} from "../src/lib/incident-reducer.ts";
import type { IncidentState, Transcript } from "../src/lib/types.ts";

/**
 * PHASE 1 CORE ACCEPTANCE
 *
 * Covers the Phase 1 deliverables that carry real logic — RTM transcript
 * deduplication and delta merging — plus the state invariants the dashboard
 * depends on. Everything here is pure, so it runs in milliseconds with no
 * browser and no backend. This is Tier 1 of the Rehearsal Rig (v6 §15).
 */

const apply = (actions: IncidentAction[], from = initialIncidentState) =>
  actions.reduce(incidentReducer, from);

const frame = (over: Partial<Transcript> = {}): Transcript => ({
  messageId: "m1",
  uid: 1001,
  role: "DevOps Lead",
  text: "partial",
  isFinal: false,
  at: 1000,
  ...over,
});

/* ========================================================================== */
describe("RTM transcript deduplication", () => {
  /* ======================================================================== */

  test("repeated partials on one messageId collapse into a single entry", () => {
    const s = apply([
      { type: "TRANSCRIPT", payload: frame({ text: "Wait," }) },
      { type: "TRANSCRIPT", payload: frame({ text: "Wait, I just" }) },
      { type: "TRANSCRIPT", payload: frame({ text: "Wait, I just checked" }) },
    ]);

    assert.equal(
      s.transcripts.length,
      1,
      "three frames sharing a messageId must render as one line",
    );
    assert.equal(s.transcripts[0].text, "Wait, I just checked");
    assert.equal(s.transcripts[0].isFinal, false);
  });

  test("a final frame overwrites its partial in place", () => {
    const s = apply([
      { type: "TRANSCRIPT", payload: frame({ text: "Memory's at" }) },
      {
        type: "TRANSCRIPT",
        payload: frame({ text: "Memory's at 40 percent.", isFinal: true }),
      },
    ]);

    assert.equal(s.transcripts.length, 1);
    assert.equal(s.transcripts[0].text, "Memory's at 40 percent.");
    assert.equal(s.transcripts[0].isFinal, true);
  });

  test("a late partial arriving after its final is discarded", () => {
    // RTM does not guarantee ordering. Without the isFinal guard, a straggling
    // partial would truncate a sentence the operator has already read.
    const s = apply([
      {
        type: "TRANSCRIPT",
        payload: frame({ text: "The cache is fine.", isFinal: true }),
      },
      { type: "TRANSCRIPT", payload: frame({ text: "The cache is" }) },
    ]);

    assert.equal(s.transcripts.length, 1);
    assert.equal(s.transcripts[0].text, "The cache is fine.");
  });

  test("distinct messageIds coexist and stay ordered by timestamp", () => {
    const s = apply([
      { type: "TRANSCRIPT", payload: frame({ messageId: "b", at: 2000 }) },
      { type: "TRANSCRIPT", payload: frame({ messageId: "a", at: 1000 }) },
      { type: "TRANSCRIPT", payload: frame({ messageId: "c", at: 3000 }) },
    ]);

    assert.deepEqual(
      s.transcripts.map((t) => t.messageId),
      ["a", "b", "c"],
      "out-of-order arrival must still render chronologically",
    );
  });
});

/* ========================================================================== */
describe("Delta merge integrity", () => {
  /* ======================================================================== */

  test("re-sending an entity updates it in place rather than duplicating", () => {
    const s = apply([
      {
        type: "DELTA",
        payload: {
          entities: [
            { id: "redis", label: "Redis Primary", kind: "datastore", status: "WARNING" },
          ],
        },
      },
      {
        type: "DELTA",
        payload: {
          entities: [
            { id: "redis", label: "Redis Primary", kind: "datastore", status: "CRITICAL" },
          ],
        },
      },
    ]);

    assert.equal(s.entities.length, 1, "status change must not create a second node");
    assert.equal(s.entities[0].status, "CRITICAL");
  });

  test("entity ordering is preserved across updates", () => {
    // React Flow keys off order for mount stability; reordering on every delta
    // would remount nodes and kill the status transition animation.
    const s = apply([
      {
        type: "DELTA",
        payload: {
          entities: [
            { id: "a", label: "A", kind: "service", status: "OK" },
            { id: "b", label: "B", kind: "service", status: "OK" },
            { id: "c", label: "C", kind: "service", status: "OK" },
          ],
        },
      },
      {
        type: "DELTA",
        payload: {
          entities: [{ id: "a", label: "A", kind: "service", status: "CRITICAL" }],
        },
      },
    ]);

    assert.deepEqual(s.entities.map((e) => e.id), ["a", "b", "c"]);
  });

  test("timeline stays chronological regardless of arrival order", () => {
    const s = apply([
      {
        type: "DELTA",
        payload: {
          timeline: [
            { id: "t2", at: 2000, kind: "action", text: "second", actor: "Echo" },
          ],
        },
      },
      {
        type: "DELTA",
        payload: {
          timeline: [
            { id: "t1", at: 1000, kind: "signal", text: "first", actor: "Echo" },
          ],
        },
      },
    ]);

    assert.deepEqual(s.timeline.map((e) => e.id), ["t1", "t2"]);
  });

  test("partial deltas never clear untouched collections", () => {
    // The Slow Loop sends only what changed. A delta carrying just an RTI value
    // must not wipe the graph or the ledger.
    const s = apply([
      {
        type: "DELTA",
        payload: {
          entities: [{ id: "a", label: "A", kind: "service", status: "OK" }],
          claims: [
            {
              id: "c1",
              text: "x",
              epistemicStatus: "OBSERVED",
              speakerRole: "DevOps Lead",
              confidence: 0.9,
              at: 1,
            },
          ],
        },
      },
      { type: "DELTA", payload: { rti: 0.5 } },
    ]);

    assert.equal(s.entities.length, 1);
    assert.equal(s.claims.length, 1);
    assert.equal(s.rti, 0.5);
  });
});

/* ========================================================================== */
describe("State invariants", () => {
  /* ======================================================================== */

  test("RTI is clamped to [0,1] against a malformed remote frame", () => {
    assert.equal(apply([{ type: "RTI", value: 4.2 }]).rti, 1);
    assert.equal(apply([{ type: "RTI", value: -3 }]).rti, 0);
  });

  test("startedAt latches on the first live transition only", () => {
    const first = incidentReducer(initialIncidentState, {
      type: "BRIDGE",
      state: "live",
      at: 5000,
    });
    const second = incidentReducer(first, {
      type: "BRIDGE",
      state: "live",
      at: 9999,
    });

    assert.equal(second.startedAt, 5000, "the incident clock must not restart");
  });

  test("RESET returns state that deep-equals the initial state", () => {
    const dirty = apply([
      { type: "BRIDGE", state: "live", at: 1 },
      { type: "RTI", value: 0.8 },
      { type: "TRANSCRIPT", payload: frame() },
    ]);

    assert.deepEqual(incidentReducer(dirty, { type: "RESET" }), initialIncidentState);
  });

  test("the reducer never mutates the state it was given", () => {
    const before: IncidentState = structuredClone(initialIncidentState);
    incidentReducer(initialIncidentState, { type: "TRANSCRIPT", payload: frame() });

    assert.deepEqual(
      initialIncidentState,
      before,
      "a mutating reducer would make React skip renders unpredictably",
    );
  });
});

/* ========================================================================== */
describe("Ledger projections (v6 §9.1)", () => {
  /* ======================================================================== */

  const seeded = apply([
    {
      type: "DELTA",
      payload: {
        claims: [
          {
            id: "obs",
            text: "measured",
            epistemicStatus: "OBSERVED",
            speakerRole: "DevOps Lead",
            confidence: 0.96,
            at: 1,
          },
          {
            id: "tool",
            text: "queried",
            epistemicStatus: "TOOL_RESULT",
            speakerRole: "DevOps Lead",
            confidence: 0.99,
            at: 2,
          },
          {
            id: "hyp-open",
            text: "maybe eviction",
            epistemicStatus: "HYPOTHESIS",
            speakerRole: "DevOps Lead",
            confidence: 0.5,
            at: 3,
          },
          {
            id: "hyp-settled",
            text: "maybe DNS",
            epistemicStatus: "HYPOTHESIS",
            speakerRole: "Support Engineer",
            confidence: 0.4,
            at: 4,
          },
          {
            id: "inf",
            text: "derived",
            epistemicStatus: "INFERRED",
            speakerRole: "Echo",
            confidence: 0.8,
            at: 5,
            // This measurement settles the DNS hypothesis.
            supersedes: "hyp-settled",
          },
        ],
        unchecked: [
          { id: "gap1", description: "nobody checked the path", at: 6 },
        ],
        tasks: [
          { id: "t1", assigneeRole: "DevOps Lead", description: "x", status: "OPEN", at: 1 },
          { id: "t2", assigneeRole: "Database Admin", description: "y", status: "DONE", at: 2 },
        ],
        contradictions: [
          {
            id: "c1",
            claimA: "obs",
            claimB: "tool",
            speakers: ["DevOps Lead", "Support Engineer"],
            resolved: false,
            at: 1,
          },
        ],
      },
    },
  ]);

  test("established = OBSERVED + TOOL_RESULT", () => {
    assert.deepEqual(selectEstablished(seeded).map((c) => c.id), ["obs", "tool"]);
  });

  test("hypotheses projection excludes observations and inferences", () => {
    assert.deepEqual(
      selectHypotheses(seeded).map((c) => c.id),
      ["hyp-open", "hyp-settled"],
    );
  });

  test("inferences are isolable — the Bridge filter depends on it", () => {
    assert.deepEqual(selectInferences(seeded).map((c) => c.id), ["inf"]);
  });

  test("a superseded hypothesis is no longer open", () => {
    assert.deepEqual(selectOpenHypotheses(seeded).map((c) => c.id), ["hyp-open"]);
  });

  test("unresolved risks combine open hypotheses and unchecked gaps", () => {
    const risks = selectUnresolvedRisks(seeded);
    assert.deepEqual(risks.hypotheses.map((h) => h.id), ["hyp-open"]);
    assert.deepEqual(risks.unchecked.map((u) => u.id), ["gap1"]);
    assert.equal(risks.count, 2);
  });

  test("open contradictions exclude resolved ones", () => {
    assert.equal(selectOpenContradictions(seeded).length, 1);
    const cleared = incidentReducer(seeded, {
      type: "RESOLVE_CONTRADICTION",
      id: "c1",
    });
    assert.equal(selectOpenContradictions(cleared).length, 0);
  });

  test("open tasks exclude completed work", () => {
    assert.deepEqual(selectOpenTasks(seeded).map((t) => t.id), ["t1"]);
  });
});
