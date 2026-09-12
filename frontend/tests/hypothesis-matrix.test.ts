import test from "node:test";
import assert from "node:assert/strict";

import {
  initialIncidentState,
  selectHypothesisMatrix,
  incidentReducer,
} from "../src/lib/incident-reducer.ts";
import type { Claim } from "../src/lib/types.ts";

test("Hypothesis Elimination Matrix — selector projections", async (t) => {
  await t.test("untouched hypothesis is OPEN with suggested probe", () => {
    const hyp: Claim = {
      id: "h1",
      text: "Maybe Redis is out of memory and evicting keys",
      entity: "redis",
      epistemicStatus: "HYPOTHESIS",
      speakerRole: "DevOps Lead",
      confidence: 0.7,
      at: 1000,
    };

    const state = {
      ...initialIncidentState,
      claims: [hyp],
    };

    const matrix = selectHypothesisMatrix(state);
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0].status, "OPEN");
    assert.equal(matrix[0].suggestedProbe?.entity, "redis");
    assert.equal(matrix[0].suggestedProbe?.provider, "Datadog APM");
  });

  await t.test("telemetry with normal metrics refutes resource exhaustion hypothesis", () => {
    const hyp: Claim = {
      id: "h1",
      text: "Maybe Redis is out of memory and evicting keys",
      entity: "redis",
      epistemicStatus: "HYPOTHESIS",
      speakerRole: "DevOps Lead",
      confidence: 0.7,
      at: 1000,
    };

    const probe: Claim = {
      id: "p1",
      text: "Datadog APM telemetry: Redis primary memory utilization is 34.2% (2.7 GB / 8.0 GB max). Eviction count: 0 keys.",
      entity: "redis",
      epistemicStatus: "TOOL_RESULT",
      speakerRole: "Datadog APM",
      confidence: 1.0,
      at: 2000,
    };

    const state = {
      ...initialIncidentState,
      claims: [hyp, probe],
    };

    const matrix = selectHypothesisMatrix(state);
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0].status, "REFUTED");
    assert.equal(matrix[0].evidenceClaim?.id, "p1");
    assert.ok(matrix[0].reason?.includes("telemetry confirms normal operational thresholds"));
  });

  await t.test("telemetry with critical metrics corroborates symptom hypothesis", () => {
    const hyp: Claim = {
      id: "h2",
      text: "Is the transit gateway dropping packets?",
      entity: "network",
      epistemicStatus: "HYPOTHESIS",
      speakerRole: "Site Reliability Engineer",
      confidence: 0.8,
      at: 1000,
    };

    const probe: Claim = {
      id: "p2",
      text: "CloudWatch telemetry: VPC Netpath us-east-1a packet drop rate is 92.4% (baseline: <0.1%, RTT: 340ms).",
      entity: "network",
      epistemicStatus: "TOOL_RESULT",
      speakerRole: "CloudWatch",
      confidence: 1.0,
      at: 2000,
    };

    const state = {
      ...initialIncidentState,
      claims: [hyp, probe],
    };

    const matrix = selectHypothesisMatrix(state);
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0].status, "CORROBORATED");
    assert.equal(matrix[0].evidenceClaim?.id, "p2");
    assert.ok(matrix[0].reason?.includes("observed telemetry aligns with reported symptom"));
  });

  await t.test("DELTA action updating claim lifecycle to REFUTED reflects in matrix", () => {
    const hyp: Claim = {
      id: "h3",
      text: "Cache is full",
      entity: "redis",
      epistemicStatus: "HYPOTHESIS",
      speakerRole: "DevOps Lead",
      confidence: 0.6,
      at: 1000,
      lifecycle: "ACTIVE",
    };

    let state = {
      ...initialIncidentState,
      claims: [hyp],
    };

    assert.equal(selectHypothesisMatrix(state)[0].status, "OPEN");

    // Server reconciles and broadcasts DELTA with lifecycle="REFUTED"
    state = incidentReducer(state, {
      type: "DELTA",
      payload: {
        claims: [{ ...hyp, lifecycle: "REFUTED" }],
      },
    });

    const matrix = selectHypothesisMatrix(state);
    assert.equal(matrix.length, 1);
    assert.equal(matrix[0].status, "REFUTED");
  });
});

