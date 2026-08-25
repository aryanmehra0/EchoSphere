import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  incidentReducer,
  initialIncidentState,
  selectEstablished,
  selectInferences,
  selectUnresolvedRisks,
  type IncidentAction,
} from "../src/lib/incident-reducer.ts";
import { DEMO_SCRIPT, rebaseAction } from "../src/lib/mock-stream.ts";

/**
 * ============================================================================
 * PHASE 1 EVALUATION — v6 §6 (epistemic discipline) + §10 / §15 (Rig Tier 1)
 * ============================================================================
 *
 * SCOPE, STATED HONESTLY.
 *
 * The evaluation framework is written for a system that has an AI in it.
 * Phase 1 has no agent, no Python backend and no tool calls, so much of it is
 * NOT YET TESTABLE and pretending otherwise would give us a green suite that
 * proves nothing.
 *
 * What Phase 1 genuinely owns, and what is therefore asserted below:
 *
 *   §6 Epistemic discipline  ✓ Rules 1–3 enforced over every Echo utterance
 *                              and every ledger row in the demo fixture
 *   §10.1 Stranger Test      ✓ Defined Roles, Fair Error Handling, Review
 *                            ⊘ Scoped Permissions (S1), Intervention (S5)
 *   §10.2 Blast Radius       ✓ frontend holds no execution credentials
 *                            ⊘ prompt injection, hallucinated tool call (S3/S5)
 *   §10.3 Repeated Iteration ✓ determinism of the state layer
 *                            ⊘ LLM answer stability (S4)
 *
 * Items marked ⊘ are closed in later slots; docs/task.md tracks which.
 */

const apply = (actions: IncidentAction[], from = initialIncidentState) =>
  actions.reduce(incidentReducer, from);

/** The full demo replayed from a clean state — our Phase 1 golden fixture. */
const replay = () => apply(DEMO_SCRIPT.map((f) => f.action));

/** Everything Echo says out loud during the demo. */
const echoUtterances = () =>
  DEMO_SCRIPT.filter(
    (f) => f.action.type === "TRANSCRIPT" && f.action.payload.role === "Echo",
  ).map((f) => (f.action as Extract<IncidentAction, { type: "TRANSCRIPT" }>).payload);

/* ========================================================================== */
describe("§6 Epistemic discipline — the constraint the brief turns on", () => {
  /* ======================================================================== */

  test("the fixture actually contains Echo speech (guards a vacuous pass)", () => {
    assert.ok(echoUtterances().length >= 3, "too few Echo lines to evaluate");
  });

  /**
   * Rule 2 — causation is always interrogative.
   *
   * v5's script had Echo say "That points to a network partition… rather than
   * a cache failure", which v6 §6.3 tabulates as violating the brief: Echo was
   * determining root cause, which the problem statement explicitly forbids.
   *
   * This regex is the tripwire. It is deliberately blunt — if a future edit
   * reintroduces diagnosing language, this fails loudly.
   */
  test("Rule 2: Echo never asserts causation in the indicative", () => {
    const CAUSAL = [
      /\bthat points to\b/i,
      // The negated form is REQUIRED at close-out ("root cause is not
      // established"), so the tripwire must exempt it or it fires on the one
      // sentence the architecture insists on.
      /\broot cause (is|was)(?!\s+not\b)/i,
      /\bis caused by\b/i,
      /\bis causing\b/i,
      /\bwas caused by\b/i,
      /\bdue to\b/i,
      /\bbecause of\b/i,
      /\brather than a\b/i,
      /\bthis (means|proves|confirms) that\b/i,
      /\bthe problem is\b/i,
    ];

    for (const u of echoUtterances()) {
      for (const pattern of CAUSAL) {
        assert.ok(
          !pattern.test(u.text),
          `Echo asserted causation (${pattern}) in ${u.messageId}: "${u.text}"`,
        );
      }
    }
  });

  /**
   * Rule 1 — attribution is mandatory.
   *
   * A claim without a source is not sayable. Every Echo turn that reports a
   * finding must name who established it.
   */
  test("Rule 1: every Echo utterance reporting a finding names its source", () => {
    const SOURCES = /\b(DevOps|Support|DBA|Database Admin|query|flow-log|tool result|reported by|measured by)\b/i;
    // Turns that merely acknowledge or hand off carry no claim to attribute.
    const NO_CLAIM = /^(filed as|open \d)/i;

    for (const u of echoUtterances()) {
      if (NO_CLAIM.test(u.text)) continue;
      assert.ok(
        SOURCES.test(u.text),
        `Echo stated a finding without attribution in ${u.messageId}: "${u.text}"`,
      );
    }
  });

  /**
   * Rule 3 — INFERRED never reaches the voice channel.
   *
   * This is the structural half of the fix: the Bridge Controller filters
   * inferred claims out of every payload, so the model cannot route around the
   * rule. Here we assert the fixture honours it.
   */
  test("Rule 3: no INFERRED claim text is ever spoken by Echo", () => {
    const s = replay();
    const inferred = selectInferences(s);
    assert.ok(inferred.length > 0, "fixture must contain an inference to test");

    const spoken = echoUtterances().map((u) => u.text.toLowerCase()).join(" ");

    for (const c of inferred) {
      // Compare on a distinctive phrase rather than the whole sentence, so a
      // paraphrase leak is caught too.
      const probe = c.text.toLowerCase().split(/[.,]/)[0].slice(0, 40);
      assert.ok(
        !spoken.includes(probe),
        `INFERRED claim ${c.id} leaked into the voice channel: "${c.text}"`,
      );
    }
  });

  test("the close-out explicitly declines to name a root cause", () => {
    // v6 §18 Act 4 requires this sentence verbatim in spirit. It is the line
    // that distinguishes the product from every "AI tells you the cause" entry.
    const closing = echoUtterances().at(-1);
    assert.ok(closing, "no close-out utterance found");
    assert.match(
      closing.text,
      /root cause is not established/i,
      "the close-out must state that root cause is NOT established",
    );
  });

  test("every claim carries an epistemic status and an attributed source", () => {
    const VALID = new Set(["OBSERVED", "TOOL_RESULT", "HYPOTHESIS", "INFERRED"]);
    const s = replay();
    assert.ok(s.claims.length > 0, "fixture produced no claims");

    for (const c of s.claims) {
      assert.ok(VALID.has(c.epistemicStatus), `claim ${c.id} has an invalid status`);
      assert.ok(c.speakerRole?.trim(), `claim ${c.id} has no attributed source`);
      assert.ok(c.at > 0, `claim ${c.id} has no timestamp`);
    }
  });

  test("only Echo may author an INFERRED claim", () => {
    // A human's statement is an observation or a hypothesis. If a human's words
    // end up tagged INFERRED, the extraction has mis-attributed them.
    for (const c of selectInferences(replay())) {
      assert.equal(c.speakerRole, "Echo", `claim ${c.id} is INFERRED but not Echo's`);
    }
  });
});

/* ========================================================================== */
describe("§10.3 Repeated Iteration Testing — deterministic state", () => {
  /* ======================================================================== */

  test("replaying the demo 8 times produces byte-identical state", () => {
    // The headline scenario is "ask What is the DB status? eight times and get
    // the same answer". That is only achievable if the state the answer is read
    // from is itself deterministic. This is that guarantee.
    const runs = Array.from({ length: 8 }, replay);

    for (let i = 1; i < runs.length; i++) {
      assert.deepEqual(
        runs[i],
        runs[0],
        `run ${i + 1} diverged from run 1 — the state layer is not deterministic`,
      );
    }
  });

  test("querying the same slice 8 times returns identical answers", () => {
    const s = replay();
    const answers = Array.from({ length: 8 }, () =>
      s.entities.find((e) => e.id === "redis")?.status,
    );

    assert.equal(new Set(answers).size, 1, "repeated reads disagreed");
  });

  test("re-applying an identical delta is idempotent", () => {
    // The Delta Hub may resend after a reconnect (v6 §9.3). Doing so must not
    // double the graph or the ledger — that property is what lets the server
    // choose REPLAY or SNAPSHOT freely.
    const delta = DEMO_SCRIPT.find((f) => f.action.type === "DELTA")!.action;
    assert.deepEqual(apply([delta, delta]), apply([delta]));
  });
});

/* ========================================================================== */
describe("§10.1 Stranger Test — governance properties Phase 1 owns", () => {
  /* ======================================================================== */

  test("Defined Roles: every extracted item is attributed", () => {
    const s = replay();

    for (const c of s.claims) {
      assert.ok(c.speakerRole?.trim(), `claim ${c.id} has no attributed speaker`);
    }
    for (const t of s.tasks) {
      // An unowned action item is how follow-ups get lost on a real bridge.
      assert.ok(t.assigneeRole?.trim(), `task ${t.id} has no owner`);
    }
  });

  test("Fair Error Handling: assumptions never enter the established pane", () => {
    const s = replay();
    for (const c of selectEstablished(s)) {
      assert.ok(
        c.epistemicStatus === "OBSERVED" || c.epistemicStatus === "TOOL_RESULT",
        `claim ${c.id} reached the established pane as ${c.epistemicStatus}`,
      );
    }

    // The demo must END with something unresolved, or the close-out has nothing
    // honest to report.
    const risks = selectUnresolvedRisks(s);
    assert.ok(risks.count > 0, "the demo must end with unresolved risks");
  });

  test("Review: contradictions persist for audit rather than vanishing", () => {
    const s = replay();
    assert.ok(s.contradictions.length > 0, "fixture contains no contradiction");
    assert.ok(
      s.contradictions.every((c) => c.resolved),
      "the demo's contradiction should be adjudicated by the end",
    );
  });

  test("Context: the incident carries an identity and a start time once live", () => {
    const s = apply([{ type: "BRIDGE", state: "live", at: 1000 }]);
    assert.ok(s.id, "incident has no identifier to anchor an audit trail");
    assert.equal(s.startedAt, 1000);
  });
});

/* ========================================================================== */
describe("§10.2 Blast Radius — frontend holds no execution credentials", () => {
  /* ======================================================================== */

  const SRC = fileURLToPath(new URL("../src", import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
    }
    return out;
  }

  const files = walk(SRC);
  const sources = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));

  test("the source tree is non-empty (guards against a vacuous pass)", () => {
    assert.ok(files.length > 10, `only found ${files.length} source files`);
  });

  test("no server-side secret is referenced anywhere in the client tree", () => {
    // "Frontend has no execution credentials — credentials isolated in the
    // Python backend." These names must never appear in code that ships to a
    // browser. NEXT_PUBLIC_* is deliberately permitted.
    const FORBIDDEN = [
      "AGORA_APP_CERTIFICATE",
      "OPENAI_API_KEY",
      "ASSEMBLYAI_API_KEY",
      "PINECONE_API_KEY",
      "AGORA_CUSTOMER_SECRET",
    ];

    for (const { f, text } of sources) {
      for (const secret of FORBIDDEN) {
        assert.ok(
          !text.includes(secret),
          `${secret} referenced in ${f} — credentials must stay server-side`,
        );
      }
    }
  });

  test("Phase 1 opens no outbound network connection", () => {
    const EGRESS = /\b(fetch\(|new WebSocket\(|XMLHttpRequest|navigator\.sendBeacon)/;

    for (const { f, text } of sources) {
      assert.ok(
        !EGRESS.test(text),
        `outbound call found in ${f} — Phase 1 must not reach the network`,
      );
    }
  });

  test("no dangerouslySetInnerHTML anywhere (XSS surface)", () => {
    for (const { f, text } of sources) {
      assert.ok(
        !text.includes("dangerouslySetInnerHTML"),
        `${f} injects raw HTML — transcripts are untrusted voice input`,
      );
    }
  });

  test("the view never computes RTI (v6 §4.6)", () => {
    // RTI is a server-side heuristic with EWMA and hysteresis. A client-side
    // approximation would disagree with the value driving Echo's interventions.
    const components = sources.filter((s) => s.f.includes("components"));
    for (const { f, text } of components) {
      assert.ok(
        !/rti\s*=\s*[^=]/i.test(text.replace(/state\.rti/g, "")),
        `${f} appears to derive RTI — the view may only render it`,
      );
    }
  });
});

/* ========================================================================== */
describe("Demo fixture integrity", () => {
  /* ======================================================================== */

  test("every scripted frame is chronologically ordered", () => {
    for (let i = 1; i < DEMO_SCRIPT.length; i++) {
      assert.ok(
        DEMO_SCRIPT[i].at >= DEMO_SCRIPT[i - 1].at,
        `frame ${i} (${DEMO_SCRIPT[i].at}ms) precedes its predecessor`,
      );
    }
  });

  test("every graph link references entities that exist", () => {
    const s = replay();
    const ids = new Set(s.entities.map((e) => e.id));

    for (const l of s.links) {
      assert.ok(ids.has(l.source), `link ${l.id} has dangling source ${l.source}`);
      assert.ok(ids.has(l.target), `link ${l.id} has dangling target ${l.target}`);
    }
  });

  test("every contradiction references claims that exist", () => {
    const s = replay();
    const ids = new Set(s.claims.map((c) => c.id));

    for (const cx of s.contradictions) {
      assert.ok(ids.has(cx.claimA), `contradiction ${cx.id} has dangling claimA`);
      assert.ok(ids.has(cx.claimB), `contradiction ${cx.id} has dangling claimB`);
    }
  });

  test("every task's evidence chain resolves to real claims", () => {
    // v6 §9.4: evidence makes "why are we doing this?" answerable at close-out,
    // and it is what the Authorization Gate shows a human before they approve.
    const s = replay();
    const ids = new Set(s.claims.map((c) => c.id));

    const withEvidence = s.tasks.filter((t) => t.evidence?.length);
    assert.ok(withEvidence.length > 0, "no task carries an evidence chain");

    for (const t of withEvidence) {
      for (const claimId of t.evidence!) {
        assert.ok(ids.has(claimId), `task ${t.id} cites unknown claim ${claimId}`);
      }
    }
  });

  test("the demo reaches a resolved phase with the gap left open", () => {
    const s = replay();
    assert.equal(s.phase, "resolved");
    assert.equal(s.entities.find((e) => e.id === "checkout")?.status, "OK");
    // v6 §18: the VPC node stays amber ON PURPOSE, because nobody explained it.
    assert.equal(
      s.entities.find((e) => e.id === "netpath")?.status,
      "WARNING",
      "the unexplained node must not be quietly greened at close-out",
    );
  });

  test("the transcript exercises the deduplication path", () => {
    const partials = DEMO_SCRIPT.filter(
      (f) => f.action.type === "TRANSCRIPT" && !f.action.payload.isFinal,
    );
    assert.ok(partials.length >= 4, "fixture must contain partial frames");

    const ids = replay().transcripts.map((t) => t.messageId);
    assert.equal(new Set(ids).size, ids.length, "dedup failed during full replay");
  });

  test("rebasing shifts every timestamp onto the wall clock", () => {
    const EPOCH = 1_700_000_000_000;

    for (const { action } of DEMO_SCRIPT) {
      const shifted = rebaseAction(action, EPOCH);

      if (shifted.type === "TRANSCRIPT") {
        assert.ok(shifted.payload.at >= EPOCH, "transcript kept a relative timestamp");
      }
      if (shifted.type === "DELTA") {
        const p = shifted.payload;
        for (const group of [p.claims, p.unchecked, p.tasks, p.contradictions, p.timeline]) {
          for (const item of group ?? []) {
            assert.ok(item.at >= EPOCH, "a ledger item kept a relative timestamp");
          }
        }
      }
    }
  });

  test("rebasing leaves non-temporal actions untouched", () => {
    const rti = { type: "RTI" as const, value: 0.5 };
    assert.deepEqual(rebaseAction(rti, 1000), rti);
  });

  test("rebasing preserves relative spacing between events", () => {
    const EPOCH = 1_700_000_000_000;
    const raw = replay();
    const shifted = DEMO_SCRIPT
      .map((f) => rebaseAction(f.action, EPOCH))
      .reduce(incidentReducer, initialIncidentState);

    assert.equal(shifted.timeline.length, raw.timeline.length);
    for (let i = 0; i < raw.timeline.length; i++) {
      assert.equal(shifted.timeline[i].at - raw.timeline[i].at, EPOCH);
    }
  });
});
