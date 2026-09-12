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
  selectClaimsByIds,
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
describe("SNAPSHOT — the reconnect handshake (v6 §9.3)", () => {
  /* ======================================================================== */

  const seeded = apply([
    {
      type: "DELTA",
      payload: {
        entities: [
          { id: "stale", label: "Stale", kind: "service", status: "OK" },
        ],
        claims: [
          {
            id: "gone",
            text: "a claim the server has since dropped",
            epistemicStatus: "OBSERVED",
            speakerRole: "DevOps Lead",
            confidence: 0.9,
            at: 1,
          },
        ],
      },
    },
  ]);

  test("a snapshot REPLACES server-owned collections rather than merging", () => {
    // This is the whole reason SNAPSHOT is not just another DELTA. Merging
    // would leave `stale`/`gone` on screen after the server had removed them,
    // and a reconnecting dashboard showing claims that no longer exist is
    // worse than one showing nothing.
    const s = incidentReducer(seeded, {
      type: "SNAPSHOT",
      payload: {
        entities: [{ id: "fresh", label: "Fresh", kind: "service", status: "OK" }],
        claims: [],
      },
    });

    assert.deepEqual(s.entities.map((e) => e.id), ["fresh"]);
    assert.equal(s.claims.length, 0, "the dropped claim survived the snapshot");
  });

  test("a snapshot preserves state the CLIENT owns", () => {
    // The server has no opinion about whether this browser is connected, and
    // applying a snapshot must never drop the operator's scrollback or restart
    // the incident clock.
    const live = apply(
      [
        { type: "BRIDGE", state: "live", at: 5000 },
        { type: "TRANSCRIPT", payload: frame({ text: "said aloud", isFinal: true }) },
      ],
      seeded,
    );

    const s = incidentReducer(live, { type: "SNAPSHOT", payload: { entities: [] } });

    assert.equal(s.bridge, "live", "snapshot dropped the transport state");
    assert.equal(s.startedAt, 5000, "snapshot restarted the incident clock");
    assert.equal(s.transcripts.length, 1, "snapshot wiped the transcript feed");
  });

  test("a snapshot keeps the timeline chronological", () => {
    const s = incidentReducer(seeded, {
      type: "SNAPSHOT",
      payload: {
        timeline: [
          { id: "b", at: 2000, kind: "action", text: "second", actor: "Echo" },
          { id: "a", at: 1000, kind: "signal", text: "first", actor: "Echo" },
        ],
      },
    });

    assert.deepEqual(s.timeline.map((e) => e.id), ["a", "b"]);
  });

  test("replaying deltas after a snapshot is idempotent", () => {
    // The server chooses REPLAY or SNAPSHOT freely; the client must survive
    // either, and survive the same delta arriving twice.
    const delta: IncidentAction = {
      type: "DELTA",
      payload: {
        entities: [{ id: "n1", label: "N1", kind: "service", status: "OK" }],
      },
    };

    const once = apply([{ type: "SNAPSHOT", payload: { entities: [] } }, delta]);
    const twice = apply([
      { type: "SNAPSHOT", payload: { entities: [] } },
      delta,
      delta,
    ]);

    assert.deepEqual(twice, once);
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

describe("selectClaimsByIds — a bad shape must not crash the console", () => {
  /*
    `Task.evidence` is fed by the analysis model, and one live extraction
    returned it as PROSE rather than a list of claim ids:

        "evidence": "Priya, can you check the replica lag in the next ten minutes?"

    The guard was `if (!ids?.length) return []`. A string has `.length`, so it
    passed, and `.map` threw `ids.map is not a function` — React unmounted the
    tree and the whole console reset mid-incident, losing the in-memory Ledger
    before write-behind had flushed it to Postgres.

    The real fix is `coerce_str_list` in models.py. This is the second line of
    defence: a selector that crashes the app on unexpected input is the wrong
    shape no matter who is feeding it.
  */
  const state = {
    ...initialIncidentState,
    claims: [
      { id: "c1", text: "memory at 40 percent", epistemicStatus: "OBSERVED",
        speakerRole: "DevOps Lead", confidence: 0.9, at: 1 },
      { id: "c2", text: "cache read timeouts", epistemicStatus: "OBSERVED",
        speakerRole: "Support Engineer", confidence: 0.9, at: 2 },
    ],
  } as typeof initialIncidentState;

  test("a prose string returns empty instead of throwing", () => {
    const ids = "Priya, can you check the replica lag?" as unknown as string[];
    assert.doesNotThrow(() => selectClaimsByIds(state, ids));
    assert.deepEqual(selectClaimsByIds(state, ids), []);
  });

  test("a real id list still resolves", () => {
    assert.deepEqual(
      selectClaimsByIds(state, ["c1", "c2"]).map((c) => c.id),
      ["c1", "c2"],
    );
  });

  test("unknown ids are dropped, known ones kept", () => {
    assert.deepEqual(
      selectClaimsByIds(state, ["c1", "nope"]).map((c) => c.id),
      ["c1"],
    );
  });

  test("undefined, null and objects are all survivable", () => {
    for (const bad of [undefined, null, 42, {}, { length: 3 }]) {
      assert.doesNotThrow(() => selectClaimsByIds(state, bad as unknown as string[]));
      assert.deepEqual(selectClaimsByIds(state, bad as unknown as string[]), []);
    }
  });
});

describe("a correction retires the claim it replaces", () => {
  /*
    Reported live. After "Correction, memory is actually at ninety five
    percent, not forty", the ESTABLISHED pane listed BOTH readings at 100%:

        Memory is at forty percent right now.        100%
        The memory is at ninety five percent right.  100%

    Two incompatible facts, both presented as settled — the exact failure
    this product exists to prevent, displayed by the product itself.

    `selectOpenHypotheses` already filtered on `selectSupersededIds`;
    `selectEstablished` did not. The backend's `Ledger.established()` had the
    same gap and was fixed with it — the two must stay in step, because
    `query_incident_state` reads one and the dashboard renders the other.
  */
  const claim = (id: string, text: string, supersedes?: string) => ({
    id, text, epistemicStatus: "OBSERVED" as const,
    speakerRole: "DevOps Lead", confidence: 1, at: 1, entity: "memory",
    ...(supersedes ? { supersedes } : {}),
  });

  const corrected = {
    ...initialIncidentState,
    claims: [
      claim("c1", "Memory is at forty percent"),
      claim("c2", "memory is actually at ninety five percent", "c1"),
    ],
  } as typeof initialIncidentState;

  test("the corrected reading is not established any more", () => {
    const ids = selectEstablished(corrected).map((c) => c.id);
    assert.deepEqual(ids, ["c2"], "the retired 40 percent reading is still shown");
  });

  test("but it is still ON the record", () => {
    // "What did we believe at 02:08" is a question an incident review asks.
    assert.equal(corrected.claims.length, 2);
  });

  test("with no correction, nothing is hidden", () => {
    const plain = {
      ...initialIncidentState,
      claims: [claim("c1", "Memory is at forty percent")],
    } as typeof initialIncidentState;
    assert.deepEqual(selectEstablished(plain).map((c) => c.id), ["c1"]);
  });
});

describe("unbounded growth over a long-running incident", () => {
  /*
    A Sev-1 bridge routinely outlasts an hour. `transcripts` and `timeline`
    only ever grow — every other collection is naturally bounded by real
    incident cardinality, but these two accumulate one entry per utterance/
    signal for the whole duration. Both must cap at the most recent N with
    the OLDEST entries evicted first, never the newest.
  */
  const MAX = 2000;

  test("the transcript feed caps at the most recent entries, oldest evicted first", () => {
    const actions: IncidentAction[] = [];
    for (let i = 0; i < MAX + 50; i += 1) {
      actions.push({
        type: "TRANSCRIPT",
        payload: frame({ messageId: `m-${i}`, text: `utterance ${i}`, isFinal: true, at: i }),
      });
    }
    const state = apply(actions);
    assert.equal(state.transcripts.length, MAX);
    // The oldest 50 are gone; the newest one survives.
    assert.ok(!state.transcripts.some((t) => t.messageId === "m-0"));
    assert.ok(!state.transcripts.some((t) => t.messageId === "m-49"));
    assert.ok(state.transcripts.some((t) => t.messageId === "m-50"));
    assert.ok(state.transcripts.some((t) => t.messageId === `m-${MAX + 49}`));
  });

  test("the timeline caps at the most recent events via DELTA, oldest evicted first", () => {
    const timelineEvent = (i: number) => ({
      id: `t-${i}`, kind: "signal" as const, text: `event ${i}`, actor: "Echo", at: i,
    });
    const actions: IncidentAction[] = [];
    for (let i = 0; i < MAX + 50; i += 1) {
      actions.push({ type: "DELTA", payload: { timeline: [timelineEvent(i)] } });
    }
    const state = apply(actions);
    assert.equal(state.timeline.length, MAX);
    assert.ok(!state.timeline.some((e) => e.id === "t-0"));
    assert.ok(state.timeline.some((e) => e.id === `t-${MAX + 49}`));
  });

  test("a SNAPSHOT carrying more than the cap is trimmed too", () => {
    const timelineEvent = (i: number) => ({
      id: `t-${i}`, kind: "signal" as const, text: `event ${i}`, actor: "Echo", at: i,
    });
    const events = Array.from({ length: MAX + 50 }, (_, i) => timelineEvent(i));
    const state = incidentReducer(initialIncidentState, {
      type: "SNAPSHOT",
      payload: { timeline: events },
    });
    assert.equal(state.timeline.length, MAX);
    assert.ok(state.timeline.some((e) => e.id === `t-${MAX + 49}`));
  });
});
