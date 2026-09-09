import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { openDeltaSocket } from "../src/lib/delta-socket.ts";

/**
 * ============================================================================
 * The delta socket's failure ladder
 * ============================================================================
 *
 * ── THE BUG THESE PIN DOWN ──────────────────────────────────────────────────
 * A WebSocket pointed at a host that accepts the TCP connection but never
 * completes the upgrade - a tunnel proxying HTTP but not `/ws/deltas`, a load
 * balancer, a captive portal - fires NOTHING. No `onopen`, no `onerror`, no
 * `onclose`. The browser just waits.
 *
 * Every retry in this module hung off `onclose`, so a hung handshake produced
 * no retry, no `onUnavailable`, and no scripted-replay fallback. The console
 * sat on "Connecting to bridge" forever while the voice bridge was completely
 * healthy - microphone live, Echo listening and answering out loud. A screen
 * that contradicts the room is the worst state this console can reach, and
 * nothing in it was observably broken.
 *
 * So: a handshake that does not resolve must be treated as a failure.
 */

/* -------------------------------------------------------------------------- */
/* A fake WebSocket, controllable per test                                     */
/* -------------------------------------------------------------------------- */

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/*
  Each test installs its OWN registry.

  A single module-level array is wrong here: these tests are async and the
  runner lets one settle while another is still waiting on its retry ladder,
  so a socket opened by test A was counted by test B and the assertions
  failed for a reason that had nothing to do with the code. (Verified: every
  test passes alone.) `beforeEach` swaps in a fresh sink and the fake writes
  to whichever one is current.
*/
let opened: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSED = CLOSED;

  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;

  // Plain field, not a `constructor(readonly url)` parameter property: the
  // suite runs under bare `node --test`, whose type-stripping loader rejects
  // those outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    opened.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /*
    The browser's own behaviour: closing a CONNECTING socket still fires
    `onclose`. The hang bug depended on this NOT happening on its own, so the
    fake must fire it only when somebody actually calls close().
  */
  close(): void {
    this.closeCalls += 1;
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.();
  }

  /** The server completed the handshake. */
  acceptHandshake(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

/* -------------------------------------------------------------------------- */

const realWebSocket = globalThis.WebSocket;
const realWindow = (globalThis as { window?: unknown }).window;

/*
  Timers handed out through the fake `window`, so teardown can cancel the ones
  a test leaves behind.

  Without this the socket under test keeps a live retry timer after its test
  returns, `afterEach` puts the real (undefined) `window` back, and the timer
  then throws "Cannot read properties of undefined (reading 'setTimeout')" -
  attributed by the runner to whichever test is unlucky enough to be running.
  The symptom was three failures whose assertions were all individually
  satisfiable, which is a fixture bug wearing the costume of a code bug.
*/
let timers: NodeJS.Timeout[] = [];

beforeEach(() => {
  opened = [];
  timers = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  // The module reaches for window.setTimeout / clearTimeout.
  (globalThis as { window?: unknown }).window = {
    setTimeout: (fn: () => void, ms?: number) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id as unknown as number;
    },
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  };
});

afterEach(() => {
  // Cancel first, restore second. The reverse order is what lets a surviving
  // timer fire against a torn-down window.
  for (const id of timers) clearTimeout(id);
  timers = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Let queued timers and microtasks run. */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
// `concurrency: 1` for the same reason the registry is per-test: these cases
// each wait out a multi-second retry ladder, and overlapping them makes the
// shared fake's bookkeeping meaningless.
describe("a handshake that never resolves is a failure, not a wait", { concurrency: 1 }, () => {
  /* ======================================================================== */

  test("a hung connection eventually gives up and reports unavailable", async () => {
    /*
      The regression itself. Not one of these sockets is ever opened, closed
      or errored by the "server" - exactly what a tunnel that does not proxy
      the WebSocket path does.

      Before the connect timeout this test hangs at zero retries forever: the
      real assertion is that `onUnavailable` is reached AT ALL.
    */
    const statuses: string[] = [];
    let unavailable = 0;

    const socket = openDeltaSocket({
      url: "wss://tunnel.example/ws/deltas",
      dispatch: () => {},
      onStatus: (s) => statuses.push(s),
      onUnavailable: () => { unavailable += 1; },
    });

    /*
      The full ladder measures ~19s of REAL time (these are real timers): a 6s
      first attempt, four 2s retries, and capped backoff between them. 30s is
      that plus headroom on a loaded machine.

      This is the slowest test in the repo and it earns the seconds: what it
      proves is that the ladder TERMINATES. Before the connect timeout it did
      not terminate at all, and no shorter test can tell the difference
      between "slow" and "never".
    */
    await settle(30_000);

    assert.equal(unavailable, 1, "onUnavailable must fire exactly once");
    assert.equal(statuses.at(-1), "failed", "the last status must be 'failed'");
    assert.ok(
      opened.length > 1,
      `a hung handshake must be retried, not waited on (opened ${opened.length})`,
    );
    assert.ok(
      opened.every((s) => s.readyState === CLOSED),
      "every abandoned socket must be closed, not leaked",
    );

    socket.close();
  });

  test("a handshake that completes in time is not abandoned", async () => {
    // The timeout must not fire on a slow-but-real connection.
    const statuses: string[] = [];
    let unavailable = 0;

    const socket = openDeltaSocket({
      url: "wss://tunnel.example/ws/deltas",
      dispatch: () => {},
      onStatus: (s) => statuses.push(s),
      onUnavailable: () => { unavailable += 1; },
    });

    await settle(1_500);
    assert.equal(opened.length, 1);
    opened[0].acceptHandshake();
    await settle(50);

    assert.ok(statuses.includes("live"), "a completed handshake must report live");
    assert.equal(unavailable, 0, "a working socket must never report unavailable");
    assert.equal(opened[0].readyState, OPEN);
    // HELLO is what asks the server for a snapshot.
    assert.equal(opened.length, 1, "no retry for a socket that opened");
    assert.match(opened[0].sent[0] ?? "", /HELLO/);

    socket.close();
  });

  test("the timeout does not fire after the caller closes", async () => {
    /*
      Otherwise a pending timer outlives the socket and schedules a retry for
      a bridge the operator has already left - which reopens a connection
      nobody asked for.
    */
    let unavailable = 0;
    const statuses: string[] = [];

    const socket = openDeltaSocket({
      url: "wss://tunnel.example/ws/deltas",
      dispatch: () => {},
      onStatus: (s) => statuses.push(s),
      onUnavailable: () => { unavailable += 1; },
    });

    await settle(500);
    socket.close();
    const afterClose = opened.length;

    await settle(10_000);

    assert.equal(unavailable, 0, "a closed socket must not report unavailable");
    assert.equal(opened.length, afterClose, "a closed socket must not reconnect");
    assert.equal(statuses.at(-1), "idle", "close() must leave the status idle");
  });
});

/* ========================================================================== */
describe("an unreachable Slow Loop must not invent an incident", () => {
  /* ======================================================================== */
  /*
    ── WHY THIS IS A TEST AND NOT A PREFERENCE ─────────────────────────────
    `DEMO_SCRIPT` is a complete fabricated incident - claims that Redis is
    evicting keys, a checkout service, entities, a contradiction - and it is
    dispatched through the SAME reducer as real analysis. On screen there is
    nothing to distinguish it from the product working except one small
    "Rehearsal" chip.

    The console used to run it automatically whenever the delta socket could
    not be reached, which on a shared tunnel is every guest. So a guest's
    Ledger filled itself with fiction about an outage that never happened.

    Inventing incident data is the precise failure this product exists to
    prevent, so it cannot be the automatic response to a network problem. The
    fixture stays available behind NEXT_PUBLIC_DEMO_REPLAY=1 for demos.

    This asserts the FIXTURE's shape rather than the React store (which needs
    a renderer): if `DEMO_SCRIPT` ever stops being obviously fabricated data
    that lands in the Ledger and transcript, the reasoning above needs
    revisiting.
  */

  test("the demo fixture is real incident data, so it cannot be a default", async () => {
    const { DEMO_SCRIPT } = await import("../src/lib/mock-stream.ts");

    const kinds = new Set(DEMO_SCRIPT.map((f) => f.action.type));
    assert.ok(
      kinds.has("TRANSCRIPT"),
      "the fixture writes transcript lines — the panel the user saw filling",
    );
    assert.ok(
      kinds.has("DELTA"),
      "the fixture writes deltas — this is what fills the Ledger",
    );

    // The specific fiction, named so a reader knows what leaks if this runs.
    const dump = JSON.stringify(DEMO_SCRIPT);
    assert.match(dump, /Redis/i, "the fixture asserts a Redis theory");
    assert.match(dump, /checkout/i, "and a checkout service");
  });

  test("the replay is opt-in via NEXT_PUBLIC_DEMO_REPLAY", () => {
    /*
      The gate is read from the environment, so the default (unset) is OFF.
      Pinned as an exact === "1" comparison: a truthiness check would make
      NEXT_PUBLIC_DEMO_REPLAY=0 or ="false" turn the fabrication ON, which is
      the opposite of what anybody writing that would mean.
    */
    const source = readFileSync(
      new URL("../src/lib/incident-store.tsx", import.meta.url),
      "utf8",
    );

    assert.match(
      source,
      /process\.env\.NEXT_PUBLIC_DEMO_REPLAY === "1"/,
      "the replay gate must be an exact '1' check, so unset and 0 both mean off",
    );

    // And the fallback path must not call startReplay unconditionally.
    const gateAt = source.indexOf('NEXT_PUBLIC_DEMO_REPLAY === "1"');
    const unavailableAt = source.indexOf("onUnavailable:");
    assert.ok(gateAt > unavailableAt, "the gate belongs inside onUnavailable");
  });
});
