#!/usr/bin/env node
/**
 * The demo control — one command for every step of running Echo in front of
 * someone. See `docs/DEMO.md` for what to SAY; this handles what to DO.
 *
 *   npm run demo            pre-flight. Run this before every demo.
 *   npm run demo reset      clean board, stop any stray agent
 *   npm run demo feed       speak Demo Script v2 at conversational pace
 *   npm run demo stop       stop the agent (also happens when you press J to leave)
 *
 * ── WHY A SCRIPT AND NOT A CHECKLIST ───────────────────────────────────────
 * Every item checked here is something that has actually gone wrong, and none
 * of them announce themselves. A stray agent from the last rehearsal is
 * invisible until two Echoes answer at once. A dev server that lost its port
 * to `next build` looks identical to one that is starting up. An exhausted
 * Groq budget looks like the pipeline being slow.
 *
 * A human reading a checklist under pressure skips items. This does not.
 */

const WEB = process.env.DEMO_WEB ?? "http://localhost:3000";
const API = process.env.DEMO_API ?? "http://127.0.0.1:8000";
const CHANNEL = process.env.DEMO_CHANNEL ?? "inc-4417";

const g = (s) => `\x1b[32m${s}\x1b[0m`;
const r = (s) => `\x1b[31m${s}\x1b[0m`;
const y = (s) => `\x1b[33m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const json = async (res) => { try { return await res.json(); } catch { return null; } };

async function get(url, timeout = 5000) {
  try {
    return await json(await fetch(url, { signal: AbortSignal.timeout(timeout) }));
  } catch { return null; }
}
async function post(url, body, timeout = 30000) {
  try {
    return await json(await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    }));
  } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Demo Script v2 (§18) — the same lines the Rehearsal Rig scores      */
/* ------------------------------------------------------------------ */

const SCRIPT = [
  { gap: 0, act: "Act 1", role: "DevOps Lead", uid: 1001,
    text: "Everyone on the bridge, massive spike in 500s on checkout. Latency is through the roof. Datadog looks like Redis might be evicting keys." },
  { gap: 9, act: "Act 1", role: "Support Engineer", uid: 1002,
    text: "Tickets are flooding in. Users say their carts empty the second they hit purchase." },
  { gap: 11, act: "Act 2", role: "DevOps Lead", uid: 1001,
    text: "Wait. I checked the primary Redis shard directly. Memory is at 40 percent. The cache is fine." },
  { gap: 17, act: "Act 2", role: "Support Engineer", uid: 1002,
    text: "But application logs are definitely showing cache read timeouts on the checkout path." },
];

/* ------------------------------------------------------------------ */

async function preflight() {
  console.log(`\n  ${b("PRE-FLIGHT")}  ${d(CHANNEL)}\n`);
  const problems = [];
  const say = (ok, label, detail = "", fatal = true) => {
    console.log(`  ${ok ? g("✓") : (fatal ? r("✗") : y("!"))} ${label}${detail ? d("  " + detail) : ""}`);
    if (!ok && fatal) problems.push(label);
  };

  // 1 — the console
  const web = await get(`${WEB}/api/health`);
  say(web?.ready === true, "console is up and has its credentials",
      web ? (web.missing?.length ? `missing: ${web.missing.join(", ")}` : "") : `no response from ${WEB}`);

  // 2 — the Slow Loop
  const api = await get(`${API}/health`);
  say(api?.ready === true, "Slow Loop is up",
      api ? "" : `no response from ${API} — the console will fall back to REHEARSAL`);

  // 3 — a stray agent from the last run is the classic silent killer
  const strayAgent = api?.agent?.agent_id ?? null;
  say(!strayAgent, "no leftover agent from a previous run",
      strayAgent ? `${strayAgent} still registered — run: npm run demo reset` : "");

  // 4 — a board with yesterday's incident on it derails the opening line
  const state = await post(`${API}/tools/query_incident_state`, {});
  const claims = (state?.established?.length ?? 0) + (state?.openHypotheses?.length ?? 0);
  say(claims === 0, "board is clean",
      claims ? `${claims} claims already present — run: npm run demo reset` : "");

  // 5 — recording must be ON, or the demo silently records nothing
  const privacy = await get(`${API}/privacy/inventory`);
  say(privacy?.recording !== false, "recording is ON",
      privacy?.recording === false ? "still off the record from a previous run" : "");

  // 6 — degradation state, non-fatal but you want to know before they do
  const degraded = api?.degraded;
  const isDegraded = Boolean(degraded?.voice || degraded?.extraction);
  say(!isDegraded, "no degradation banner", degraded?.banner ?? "", false);

  console.log("");
  if (problems.length === 0) {
    console.log(`  ${g(b("GO"))}  — open ${WEB}, press ${b("J")}, then: ${b("npm run demo feed")}\n`);
    console.log(d("  Volume up. Echo speaks — a silent demo of a voice product is a waste.\n"));
    return 0;
  }
  console.log(`  ${r(b("NO-GO"))} — ${problems.length} problem(s) above\n`);
  return 1;
}

async function reset() {
  console.log("");
  const stopped = await post(`${WEB}/api/stop-agent`, { channel: CHANNEL });
  console.log(`  ${stopped?.stopped ? g("stopped the previous agent") : d("no agent was running")}`);

  const res = await post(`${API}/incident/reset`);
  console.log(`  ${res ? g("board cleared") : r("could not reach the Slow Loop")}`);
  console.log(d(`\n  Now: open ${WEB}, press J, then npm run demo feed\n`));
  return res ? 0 : 1;
}

async function feed() {
  const api = await get(`${API}/health`);
  if (!api?.agent?.agent_id) {
    console.log(y("\n  Echo is not in the channel yet — press J in the browser first."));
    console.log(d("  Feeding anyway: the dashboard will fill, but Echo will not speak.\n"));
  } else {
    console.log(d(`\n  Echo is in the channel (${api.agent.agent_id})\n`));
  }

  for (const line of SCRIPT) {
    if (line.gap) await sleep(line.gap * 1000);
    const res = await post(`${API}/observer/transcript`,
                           { uid: line.uid, role: line.role, text: line.text });
    const ok = res && !res.error;
    console.log(`  ${ok ? g("✓") : r("✗")} ${d(line.act)} ${line.role.padEnd(17)} ${d(line.text.slice(0, 44) + "…")}`);
  }
  console.log(d("\n  Script complete. Give the panel ~8s to finish deliberating.\n"));
  return 0;
}

async function stop() {
  const res = await post(`${WEB}/api/stop-agent`, { channel: CHANNEL });
  console.log(`\n  ${res?.stopped ? g("agent stopped") : d("no agent was running")}\n`);
  return 0;
}

const COMMANDS = { check: preflight, reset, feed, stop };
const cmd = process.argv[2] ?? "check";

if (!COMMANDS[cmd]) {
  console.log(`\n  unknown command ${JSON.stringify(cmd)}\n`);
  console.log("  npm run demo          pre-flight check");
  console.log("  npm run demo reset    clean board, stop stray agent");
  console.log("  npm run demo feed     speak Demo Script v2");
  console.log("  npm run demo stop     stop the agent\n");
  process.exit(2);
}

/*
  `process.exitCode`, NOT `process.exit()`.

  `process.exit()` here tore the process down while undici still had sockets
  open from the health checks, and Node aborted with

      Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)

  printed straight after a perfectly good GO. The check was right and it looked
  like a crash — which is the last thing wanted from the tool you run to build
  confidence before a demo. Setting the code lets the loop drain and exit on
  its own.
*/
process.exitCode = await COMMANDS[cmd]();
