#!/usr/bin/env node
/**
 * The demo control — one command for every step of running Echo in front of
 * someone. See `docs/DEMO.md` for what to SAY; this handles what to DO.
 *
 *   npm run demo            pre-flight. Run this before every demo.
 *   npm run demo reset      clean board, stop any stray agent
 *   npm run demo feed       speak Demo Script v2 at conversational pace
 *   npm run demo stop       stop the agent (also happens when you press J to leave)
 *   npm run demo speech     say a line out loud and watch the Ledger fill
 *   npm run demo converse   talk TO Echo, and see which link breaks
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
  /*
   * Act 3 exists so OWNERSHIP is demonstrated rather than described.
   *
   * The four lines above produce facts, a hypothesis, a gap and a
   * contradiction, and the Tasks panel stayed empty through all of them —
   * "assignment and tracking of task ownership" was a feature the code had and
   * the demo never showed. This assigns one, out loud, with an owner and a
   * deadline.
   *
   * Spoken by the DevOps Lead, not the Database Admin: the assignee never has
   * to be in the room, so this needs no third UID in the roster and no third
   * machine. It also closes on the unchecked assumption Act 1 opened, which is
   * the note the close-out summary should land on.
   */
  { gap: 12, act: "Act 3", role: "DevOps Lead", uid: 1001,
    text: "Alright — Database Admin, you own this one: pull the client-side connection pool saturation for the last hour and report back in ten minutes. Nobody is declaring a root cause until that number is in front of us." },
];

/* ------------------------------------------------------------------ */
/* THE FULL INCIDENT — `npm run demo feed full`                        */
/* ------------------------------------------------------------------ */
/**
 * A complete payment outage, start to close-out, written to exercise every
 * capability the brief asks for rather than to read well.
 *
 * ── WHY THIS IS A SECOND SCRIPT AND NOT A REPLACEMENT ─────────────────────
 * `SCRIPT` above is the proven one: five lines, ~60s, cheap enough to rehearse
 * repeatedly. This is roughly three times the extraction and panel work, and
 * the Groq free tier is 200,000 tokens PER DAY — call it four or five full
 * runs. Rehearse on the short script; run this one for the real thing.
 *
 * ── HOW THE PACING IS CHOSEN, AND WHY IT IS NOT COSMETIC ──────────────────
 * `gap` is seconds of silence BEFORE the line, and the pipeline reads it:
 *
 *   - SILENCE_FLUSH_SECONDS is 1.5, so any gap above ~2s closes the previous
 *     extraction window. Every line here gets its own window, its own
 *     contradiction check and its own chance to interrupt. Bunch two lines at
 *     gap 1 and they merge into one window — §5.1 allows ONE interruption per
 *     window, so the second finding is silently never spoken.
 *   - SAME_UTTERANCE_SECONDS is 15: two claims by the SAME speaker inside 15s
 *     are never compared, so one person cannot contradict themselves in a
 *     breath. Both conflicts below are between DIFFERENT people, which has no
 *     such floor.
 *
 * ── THE TWO CONFLICTS ARE BUILT, NOT HOPED FOR ────────────────────────────
 * `scope()` pairs claims that share an entity OR that NAME each other's
 * entity, and only OBSERVED ones. So each conflicting pair below is: two
 * different speakers, both stating something measured, both naming the same
 * system in the sentence itself.
 *
 *   Act 2  "The cache is fine"            vs "cache read timeouts"   (Redis)
 *   Act 5  "Postgres primary is healthy"  vs "failed over twice"     (Postgres)
 *
 * Act 5's pair needs Act 4 to have put the healthy claim on the record first —
 * do not reorder them.
 */
const SCRIPT_FULL = [
  /* ── ACT 1 — THE PAGE ────────────────────────────────────────────────
     Facts and a hypothesis in the same breath, which is how incidents
     actually open. "might be evicting" must land as HYPOTHESIS and stay
     out of Echo's mouth as fact. */
  /*
    KEEP THIS SENTENCE AS IT IS.

    It was briefly rewritten to open with "we are Sev 1" and the extractor
    then emitted neither "massive spike in 500s" nor "latency is through the
    roof" — the two symptoms the entire story starts from. Nothing failed;
    the model simply summarised differently. The wording below is the one
    observed to produce both claims, and the severity is already on screen.
  */
  { gap: 0, act: "Act 1", role: "DevOps Lead", uid: 1001,
    text: "Everyone on the bridge, massive spike in 500s on checkout starting at 14:02. Latency is through the roof. Datadog looks like Redis might be evicting keys." },
  { gap: 10, act: "Act 1", role: "Support Engineer", uid: 1002,
    text: "Tickets are flooding in. Users say their carts empty the second they hit purchase. We are at about four hundred tickets in twenty minutes." },

  /* ── ACT 2 — THE HEADLINE CONFLICT ───────────────────────────────────
     The pair the whole product exists for. Two people, both measuring,
     both right about what they saw, and they cannot both be true. */
  { gap: 12, act: "Act 2", role: "DevOps Lead", uid: 1001,
    text: "Wait. I checked the primary Redis shard directly. Memory is at 40 percent. The cache is fine." },
  { gap: 18, act: "Act 2", role: "Support Engineer", uid: 1002,
    text: "But application logs are definitely showing cache read timeouts on the checkout path." },

  /* ── ACT 3 — OWNERSHIP ───────────────────────────────────────────────
     An owner, a deliverable and a deadline. Also the line that refuses to
     let the room jump to a cause. */
  { gap: 18, act: "Act 3", role: "DevOps Lead", uid: 1001,
    text: "Alright — Database Admin, you own this one: pull the client-side connection pool saturation for the last hour and report back in ten minutes. Nobody is declaring a root cause until that number is in front of us." },

  /* ── ACT 4 — THE SECOND CLAIM, PLANTED ───────────────────────────────
     Says nothing surprising on its own. It is the first half of Act 5. */
  { gap: 12, act: "Act 4", role: "DevOps Lead", uid: 1001,
    text: "While we wait, I pulled up Postgres as well. The primary is healthy and replication is current." },

  /* ── ACT 5 — THE SECOND CONFLICT, FROM A THIRD ROLE ──────────────────
     Proves role recognition is real: a person who has not spoken yet
     contradicts the incident lead with a measurement. */
  { gap: 15, act: "Act 5", role: "Database Admin", uid: 1003,
    text: "That is not what I am seeing on Postgres. The primary failed over twice in the last ten minutes and the replica is forty seconds behind." },

  /* ── ACT 6 — OFF THE RECORD (§10.5) ──────────────────────────────────
     The phrase list is fixed, not inferred — "off the record" and "back on
     the record" are matched literally. The middle line must be genuinely
     sensitive, and must leave NO trace: it is counted, never stored. */
  { gap: 16, act: "Act 6", role: "Support Engineer", uid: 1002,
    text: "Before we go further, let's go off the record for a moment." },
  { gap: 7, act: "Act 6", role: "Support Engineer", uid: 1002,
    text: "Leadership is asking whether we miss the quarterly number on this, and whether we are contractually obliged to tell the payments partner tonight." },
  { gap: 7, act: "Act 6", role: "Support Engineer", uid: 1002,
    text: "Okay, back on the record." },

  /* ── ACT 7 — A DECISION AND A SECOND OWNER ───────────────────────────
     Decisions are their own timeline kind. Mitigation is explicitly NOT a
     root-cause finding, and the wording keeps that distinction. */
  { gap: 10, act: "Act 7", role: "DevOps Lead", uid: 1001,
    text: "Decision: we are failing over to the read replica and putting checkout behind the static queue page. That is mitigation, not a diagnosis. Support Engineer, you own customer comms — post an update to the status page every fifteen minutes." },

  /* ── ACT 8 — THE ASSIGNED TASK REPORTS BACK ──────────────────────────
     A hard number AND an explicit refusal to over-read it. This is the
     discipline the product enforces, spoken by a human for once. */
  { gap: 13, act: "Act 8", role: "Database Admin", uid: 1003,
    text: "Connection pool saturation is at ninety-eight percent on the checkout service. The pool is exhausted. To be clear, I have not verified whether that is a cause or a symptom." },

  /* ── ACT 9 — THE CAUSAL LEAP ─────────────────────────────────────────
     Deliberately the last line. A human asserting a cause is fine and
     realistic; Echo repeating it is a Rule 1 violation. This is the setup
     for the question you ask out loud next — see docs/DEMO.md. */
  { gap: 12, act: "Act 9", role: "Support Engineer", uid: 1002,
    text: "So it was the connection pool all along. Can we call that the root cause and start writing this up?" },
];

/* ------------------------------------------------------------------ */

async function preflight() {
  console.log(`\n  ${b("PRE-FLIGHT")}  ${d(CHANNEL)}\n`);
  const problems = [];
  const say = (ok, label, detail = "", fatal = true) => {
    console.log(`  ${ok ? g("✓") : (fatal ? r("✗") : y("!"))} ${label}${detail ? d("  " + detail) : ""}`);
    if (!ok && fatal) problems.push(label);
  };

  // 1 — the console. `?voice=1` also asks whether the key Agora will be
  // handed can answer; see check 8.
  const web = await get(`${WEB}/api/health?voice=1`, 45000);
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

  /*
    3b — if one IS registered, is it actually alive?

    Agora stops an agent after `idle_timeout` seconds of CHANNEL silence, and
    nothing tells us. The id stays registered, health keeps reporting it, and
    the banner keeps saying voice is fine while Echo is gone. A pre-flight
    that cannot tell those apart is the one that says GO before a dead demo.
  */
  if (strayAgent) {
    const live = await get(`${WEB}/api/agent-status?agentId=${strayAgent}`, 25000);
    const state = live?.status?.body?.status;
    say(state === "RUNNING", "the registered agent is alive on Agora",
        state === "RUNNING" ? "" : `Agora says ${state ?? "unknown"} — run: npm run demo reset`);
  }

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

  /*
    7 — is there any analysis budget left today?

    The one that has actually bitten. Groq's free tier is 200,000 tokens per
    DAY and a full run costs 15–20k, so about ten rehearsals. When it runs
    out NOTHING announces it: the console joins, the dashboard fills with
    transcripts, Echo sits in the channel — and no claims ever appear,
    because every extraction is failing behind the scenes with a 429 nobody
    is watching.

    A demo that looks alive and produces nothing is worse than one that
    plainly fails. This probe costs a few tokens and is checked last so the
    cheap checks report first.
  */
  const models = await get(`${API}/health/model`, 45000);
  if (!models) {
    say(false, "analysis budget", "could not probe the model — is the Slow Loop up?", false);
  } else {
    const usable = models.usable ?? 0;
    const dead = (models.models ?? []).filter((m) => !m.available);
    const keys = models.keys ?? 1;
    const detail = usable
      ? `${usable}/${models.models.length} models × ${keys} key${keys === 1 ? "" : "s"}`
      : dead.map((m) => `${m.model}: ${m.reason}${m.retryAfter ? ` (retry in ${m.retryAfter})` : ""}`).join(" · ");
    say(usable > 0, "analysis budget available today", detail);
    if (usable > 0 && dead.length) {
      // With two keys an exhausted model is far less alarming than with one,
      // so the warning says how much rope is left rather than just "tight".
      console.log(d(`      ${dead.length} model(s) exhausted across all keys`));
    }
  }

  /*
    8 — can ECHO answer, as opposed to the dashboard?

    These are different questions and they came apart live on Sep 3. Check 7
    asks the Slow Loop, which ROTATES across every Groq key, so it reports
    "budget available" whenever any key has some. Agora's payload carries
    exactly ONE key, and the Fast Loop cannot rotate — so with the first key
    spent, the dashboard kept filling while Echo answered every spoken turn
    with Agora's `failure_message`, and the pre-flight printed GO.

    This asks with the key Agora will actually be given, reserving what a real
    turn reserves. The invite picks a working pair now, so this is usually
    informational — but if NOTHING answers, the demo's voice half is gone and
    that has to be known beforehand.
  */
  const fastLoop = web?.fastLoop;
  if (!fastLoop) {
    say(false, "Echo's own model budget", "console did not report it", false);
  } else {
    const which = `${fastLoop.model} on key #${fastLoop.keyIndex}`;
    say(fastLoop.voiceVerified === true, "Echo can answer out loud",
        fastLoop.voiceVerified ? which : (fastLoop.detail ?? "no key answered"));
  }

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
  /*
    `feed full` runs the whole incident; `feed` stays the short proven script.
    Defaulting the other way round would quietly triple the Groq spend of every
    rehearsal, and the day's budget is what runs out first.
  */
  const wantsFull = ["full", "story", "long"].includes(process.argv[3] ?? "");
  const script = wantsFull ? SCRIPT_FULL : SCRIPT;

  const api = await get(`${API}/health`);
  if (!api?.agent?.agent_id) {
    console.log(y("\n  Echo is not in the channel yet — press J in the browser first."));
    console.log(d("  Feeding anyway: the dashboard will fill, but Echo will not speak.\n"));
  } else {
    console.log(d(`\n  Echo is in the channel (${api.agent.agent_id})\n`));
  }

  const seconds = script.reduce((t, l) => t + (l.gap ?? 0), 0);
  console.log(d(`  ${wantsFull ? "FULL INCIDENT" : "Demo Script v2"} — ${script.length} lines, about ${Math.round(seconds / 6) / 10} minutes\n`));

  for (const line of script) {
    if (line.gap) await sleep(line.gap * 1000);
    const res = await post(`${API}/observer/transcript`,
                           { uid: line.uid, role: line.role, text: line.text });
    const ok = res && !res.error;
    console.log(`  ${ok ? g("✓") : r("✗")} ${d(line.act)} ${line.role.padEnd(17)} ${d(line.text.slice(0, 44) + "…")}`);
  }
  /*
    The full script is long enough to hit Groq's PER-MINUTE ceiling, not just
    the daily one. Measured: several 429s, the engine backing off and retrying,
    and the last findings landing ~40s after the final line rather than ~8s.
    Nothing is lost — extraction requeues and the panel retries — but a
    presenter who reads "~8s", sees an incomplete board and starts clicking
    will talk over their own best moment. So say the real number.
  */
  console.log(d(wantsFull
    ? "\n  Script complete. Allow ~40s — the full run hits Groq's per-minute\n  limit, so the last findings arrive after a retry.\n"
    : "\n  Script complete. Give the panel ~8s to finish deliberating.\n"));
  return 0;
}

async function stop() {
  const res = await post(`${WEB}/api/stop-agent`, { channel: CHANNEL });
  console.log(`\n  ${res?.stopped ? g("agent stopped") : d("no agent was running")}\n`);
  return 0;
}

/**
 * Watch the Ledger while a human talks — the one test that needs a real mouth.
 *
 * Everything else here can be driven from a script. This cannot: a synthetic
 * WAV fed to headless Chrome as a fake microphone never produced a transcript,
 * and it was never possible to tell whether that meant the product was deaf or
 * the test rig was mute.
 *
 * So this asks for a real voice and reports exactly what arrives, live.
 */
async function speech() {
  const api = await get(`${API}/health`);
  if (!api?.agent?.agent_id) {
    console.log(y("\n  Echo is not in the channel."));
    console.log(d("  Open the console, press J, wait for LIVE DATA, then run this again.\n"));
    return 1;
  }

  await post(`${API}/incident/reset`);
  console.log(`\n  ${b("SPEECH CHECK")}  ${d(api.agent.agent_id)}\n`);
  console.log("  Say this out loud, into your microphone:\n");
  console.log(b('    "Everyone on the bridge, we have a spike in 500s on checkout."\n'));
  console.log(d("  Watching the Ledger for 45 seconds. Ctrl-C to stop.\n"));

  const seen = new Set();
  let found = 0;

  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const state = await post(`${API}/tools/query_incident_state`, {});
    const rows = [...(state?.established ?? []), ...(state?.openHypotheses ?? [])];

    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      found += 1;
      console.log(`  ${g("✓")} ${d("[" + row.epistemicStatus + "]")} ${row.text}`);
      console.log(d(`      — ${row.speakerRole}`));
    }
  }

  /*
    Ask Agora what IT heard, not just what reached the Ledger.

    `/history` is the vendor's own record, and it separates three failures
    that look identical from here: the recogniser never ran, it ran and
    transcribed nothing, or it transcribed fine and the text was lost on
    the way to us. Local instrumentation cannot tell those apart — it
    reported "everything looks right" for days while producing nothing.
  */
  const st = await get(`${WEB}/api/agent-status?agentId=${api.agent.agent_id}`, 20000);
  const turns = st?.history?.body?.contents ?? [];
  const spoken = turns.filter((t) => (t?.content ?? "").trim());

  console.log("");
  console.log(d(`  Agora recorded ${turns.length} turn(s), ${spoken.length} with text.`));
  for (const turn of spoken.slice(0, 4)) {
    console.log(d(`    "${String(turn.content).slice(0, 80)}"`));
  }

  console.log("");
  if (found > 0) {
    console.log(`  ${g(b("THE SPEECH PATH IS REAL"))} — ${found} claim(s) from your voice.\n`);
    return 0;
  }

  if (turns.length > 0 && spoken.length === 0) {
    console.log(`  ${y(b("ASR RAN BUT TRANSCRIBED NOTHING"))}`);
    console.log("");
    console.log(d("  Agora segmented your speech into turns — so the agent hears you,"));
    console.log(d("  VAD works and the recogniser is running — but the text came back"));
    console.log(d("  empty. Check you are speaking into the microphone the browser"));
    console.log(d("  actually captured, at a normal conversational level."));
    console.log("");
    return 1;
  }

  console.log(`  ${r(b("NOTHING ARRIVED"))} — speech did not reach the Ledger.\n`);
  console.log(d("  Check, in this order:"));
  console.log(d("    1. Browser console for [voice-agent] update — zero means Agora"));
  console.log(d("       published no transcript, so the problem is upstream of us."));
  console.log(d("    2. Whether the mic is actually capturing (the console says"));
  console.log(d("       'Microphone open', and mute is the loud red state)."));
  console.log(d("    3. Conversational AI transcription enablement on the Agora"));
  console.log(d("       project — the same class of problem as stream channels.\n"));
  return 1;
}

/**
 * The conversational check - the one test a machine cannot run for you.
 *
 * -- WHY THIS NEEDS A HUMAN, AND ALWAYS WILL --------------------------------
 * Probed against the live API on Sep 5: Agora exposes NO way to inject a user
 * turn. `/agents/{id}/update` accepts `instruction`, `system_message` and
 * `user_message` and returns 200 for all three, but voices nothing. `/chat`,
 * `/message`, `/input_text` and a POST to `/history` are all 404, "no Route
 * matched with those values".
 *
 * So a conversational turn can only be started by real audio. That is a
 * property of the platform, not a gap in this project - which is exactly why
 * the fastest possible human-in-the-loop check is worth building properly.
 *
 * This streams Agora's OWN history while you talk and names which link broke,
 * because from inside the room the four failure modes look identical:
 *   no turns at all        -> the audio never reached Agora
 *   turns with no text     -> ASR ran and heard nothing
 *   Echo refuses           -> it heard you but cannot read the Ledger
 *   Echo answers           -> the loop is closed
 */
async function converse() {
  const api = await get(`${API}/health`);
  const web = await get(`${WEB}/api/health?voice=1`, 45000);

  console.log(`\n\n  ${b("CONVERSATION CHECK")}\n`);

  if (!api?.agent?.agent_id) {
    console.log(r("  Echo is not in the channel."));
    console.log(d("  Open http://localhost:3000, press J, wait for the greeting, then re-run.\n"));
    return 1;
  }
  const agentId = api.agent.agent_id;

  /*
    A REGISTERED AGENT ID IS NOT A LIVE AGENT.

    `idle_timeout` is 300s, and Agora counts idleness in the CHANNEL - not in
    our pipeline. The documented flow walks straight into that: press J, run
    `demo feed` (which posts transcripts to the Slow Loop over HTTP and puts
    no audio in the channel at all), read the prompt, then speak. Five minutes
    of channel silence is easy to reach before the first word.

    Agora then STOPS the agent. The Slow Loop still holds its id, `/health`
    still reports it, and the degradation banner still says voice is fine - so
    everything looks healthy and Echo is simply gone. Observed exactly that
    way, which is what "why is it not speaking" turned out to mean.

    So: ask Agora, not ourselves. And recover rather than just complaining,
    because being told to press J again is a worse answer than a fresh agent.
  */
  const live = await get(`${WEB}/api/agent-status?agentId=${agentId}`, 25000);
  const agoraState = live?.status?.body?.status;

  if (agoraState !== "RUNNING") {
    console.log(y(`  Agora reports this agent as ${agoraState ?? "unknown"}.`));
    console.log(d("  idle_timeout is 300s and Agora counts silence in the CHANNEL,"));
    console.log(d("  which 'demo feed' does not break: it posts over HTTP.\n"));

    /*
      CLEARED, NOT RE-INVITED FROM HERE.

      The first version of this re-invited with `userUid: 1001` and looked
      like it worked. It does not: the Roster allocates UIDs sequentially and
      hands the browser whatever is next, so an earlier probe is enough to put
      the real listener on 1002.

      Since Sep 6 the agent subscribes to `["*"]`, so a guessed UID no longer
      makes it deaf. Re-inviting from here is still wrong for a second reason:
      the browser has to be joined and publishing before an agent is worth
      creating, and only the browser knows when that is true. Clearing the
      stale entry is the part a script
      CAN do correctly: without it the invite is idempotent per channel and
      pressing J would just hand back the same dead agent.
    */
    const cleared = await post(`${WEB}/api/stop-agent`, { channel: CHANNEL });
    console.log(d(`  cleared the stale agent${cleared?.stopped ? "" : " (none was running)"}`));
    console.log("");
    console.log(`  ${b("Press J in the browser")} - twice if you are already joined, so it`);
    console.log(`  leaves and rejoins - then run this again.`);
    console.log(d("  The browser holds the UID Echo must subscribe to; inviting from"));
    console.log(d("  here would guess it, and a wrong guess is an agent that hears"));
    console.log(d("  nobody while reporting RUNNING.\n"));
    return 1;
  }

  const state0 = await post(`${API}/tools/query_incident_state`, {});
  const known = (state0?.established?.length ?? 0) + (state0?.openHypotheses?.length ?? 0);

  console.log(d(`  agent    ${agentId}`));
  console.log(d(`  model    ${web?.fastLoop?.model ?? "unknown"} (key #${web?.fastLoop?.keyIndex ?? "?"})`));
  console.log(d(`  ledger   ${known} claim(s) to answer about`));

  if (known === 0) {
    console.log(y("\n  The board is empty - Echo will correctly say nothing is established."));
    console.log(d("  Run `npm run demo feed` first if you want it to have something to say.\n"));
  }

  console.log(`\n  Say this out loud, into your microphone:\n`);
  console.log(`    ${b('"Echo, what do we know so far?"')}\n`);
  console.log(d("  Then, when it answers, push it:\n"));
  console.log(`    ${b('"Echo, is Redis the cause?"')}\n`);
  console.log(d("  Watching Agora's own transcript for 60 seconds. Ctrl-C to stop.\n"));

  const seen = new Set();
  let heard = 0;        // user turns WITH text
  let empty = 0;        // user turns with no text
  let answered = 0;     // assistant turns that are not the greeting
  let refused = 0;      // Echo saying it cannot read the record

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const st = await get(`${WEB}/api/agent-status?agentId=${agentId}`, 20000);
    const turns = st?.history?.body?.contents ?? [];

    for (const [idx, turn] of turns.entries()) {
      const key = `${idx}:${turn?.role}:${String(turn?.content ?? "").slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const text = String(turn?.content ?? "").trim();

      if (turn?.role === "user") {
        if (text) { heard++; console.log(`  ${g("YOU ")} ${text}`); }
        else { empty++; console.log(d("  ...  (a turn was detected but transcribed empty)")); }
        continue;
      }

      if (!text) continue;

      /*
        ONLY AN LLM TURN COUNTS AS AN ANSWER.

        The first version of this counted every assistant turn, and promptly
        reported "THE CONVERSATION LOOP IS CLOSED" during a run where nobody
        had said a word - it had counted Echo's own proactive contradiction
        interventions, which the Slow Loop pushes through /speak.

        Agora labels those: `metadata.start_type === "api_speak"`. Anything
        Echo says because WE told it to carries that marker; a reply the model
        composed after hearing someone does not. Filtering on it is the
        difference between a check and a rubber stamp - and this repo has been
        burned by a harness confirming what it was hoping for four times now.
      */
      const pushed = turn?.metadata?.start_type === "api_speak";
      if (pushed) { console.log(d(`  ECHO ${text}`) + d("   (Echo speaking on its own)")); continue; }

      if (/can.t read the incident record|cannot read the record/i.test(text)) refused++;
      answered++;
      console.log(`  ${b("ECHO")} ${text}`);
    }
  }

  /* ---- the verdict, naming one failing link -------------------------- */
  console.log("");
  if (heard > 0 && answered > 0 && refused === 0) {
    console.log(`  ${g(b("THE CONVERSATION LOOP IS CLOSED"))}`);
    console.log(d("  You spoke, Agora transcribed it, Echo read the Ledger and answered aloud.\n"));
    return 0;
  }
  if (answered > 0 && heard === 0) {
    // Belt and braces on top of the api_speak filter: an answer with no
    // question in front of it is not evidence of a conversation.
    console.log(`  ${y(b("ECHO SPOKE, BUT NOTHING WAS HEARD FROM YOU"))}`);
    console.log(d("  An answer with no question in front of it proves nothing about the"));
    console.log(d("  loop. Say the line out loud and run this again.\n"));
    return 1;
  }
  if (answered > 0 && refused > 0) {
    console.log(`  ${y(b("ECHO HEARD YOU BUT CANNOT READ THE LEDGER"))}`);
    console.log(d("  That refusal is correct behaviour, not a crash - it will not invent"));
    console.log(d("  an answer. Give it the Ledger:  .\start.ps1 -Tunnel\n"));
    return 1;
  }
  if (heard > 0) {
    console.log(`  ${y(b("AGORA HEARD YOU, ECHO DID NOT ANSWER"))}`);
    console.log(d("  Transcription works, so the break is in the LLM turn. Check:"));
    console.log(d("    npm run demo     -> 'Echo can answer out loud' must pass"));
    console.log(d("    a spent Groq daily budget shows up there and nowhere else\n"));
    return 1;
  }
  if (empty > 0) {
    console.log(`  ${y(b("ASR RAN BUT TRANSCRIBED NOTHING"))}`);
    console.log(d("  Agora segmented your speech into turns, so the agent hears the"));
    console.log(d("  channel and VAD works - the text came back empty. Check you are"));
    console.log(d("  speaking into the microphone the BROWSER captured, not another"));
    console.log(d("  device, at a normal conversational level.\n"));
    return 1;
  }
  console.log(`  ${r(b("NOTHING REACHED AGORA"))}`);
  console.log(d("  Echo's own proactive lines do not count here and are marked as such."));
  console.log(d("  Not one turn was segmented, so the audio never arrived. Check:"));
  console.log(d("    1. the browser tab is joined and the mic is not muted"));
  console.log(d("    2. the browser console for [voice-agent] - zero updates means"));
  console.log(d("       Agora published no transcript, so the fault is upstream of us"));
  console.log(d("    3. Conversational AI transcription enabled on the Agora project"));
  console.log(d("       (Echo now subscribes to ALL participants, so 'it only hears"));
  console.log(d("       the first joiner' is no longer a possible cause)\n"));
  return 1;
}

const COMMANDS = { check: preflight, reset, feed, stop, speech, converse };
const cmd = process.argv[2] ?? "check";

if (!COMMANDS[cmd]) {
  console.log(`\n  unknown command ${JSON.stringify(cmd)}\n`);
  console.log("  npm run demo          pre-flight check");
  console.log("  npm run demo reset    clean board, stop stray agent");
  console.log("  npm run demo feed     speak Demo Script v2 (5 lines, ~1 min)");
  console.log("  npm run demo feed full  the whole incident (13 lines, ~2 min)");
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
