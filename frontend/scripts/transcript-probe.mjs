/**
 * Drive the real console in a real browser and report WHERE the transcript
 * chain breaks.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * "No transcripts" has now been chased four times by reading source and
 * guessing, and each guess cost a round trip through a human with a
 * microphone. The chain has four hops and only the browser can see three of
 * them:
 *
 *   1. RTC join            — did we get into the channel at all?
 *   2. toolkit subscribe   — did `subscribeMessage` bind?
 *   3. TRANSCRIPT_UPDATED  — is the data stream carrying anything?
 *   4. forward -> Slow Loop — did our uid filter let it through?
 *
 * Agora's REST history already proves the AGENT side works. This proves, or
 * disproves, the CONSOLE side, with no human in the loop.
 *
 *   node scripts/transcript-probe.mjs
 *
 * Chrome is given a WAV as its microphone (`--use-file-for-fake-audio-capture`)
 * so real audio is published into the channel exactly as a person would.
 */
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WAV = process.env.PROBE_WAV;
const URL_ = process.env.PROBE_URL ?? "http://localhost:3000";
const SECONDS = Number(process.env.PROBE_SECONDS ?? 75);

if (!WAV) {
  console.error("PROBE_WAV must point at a 16-bit PCM .wav");
  process.exit(2);
}

const lines = [];
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();

page.on("console", (msg) => {
  const text = msg.text();
  lines.push(text);
  if (/voice-agent|agora|bridge|transcript|PTS|NO TRANSCRIPT/i.test(text)) {
    console.log(`  [${msg.type()}] ${text.slice(0, 200)}`);
  }
});
page.on("pageerror", (err) => {
  lines.push(`PAGEERROR ${err.message}`);
  console.log(`  [pageerror] ${err.message.slice(0, 200)}`);
});

console.log(`\n  opening ${URL_} ...`);
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

console.log("  pressing J to join the bridge ...");
await page.keyboard.press("j");

// Let the join, the invite and the agent's greeting all settle, then let the
// WAV play through so VAD has whole utterances to segment.
for (let i = 1; i <= SECONDS / 5; i += 1) {
  await page.waitForTimeout(5000);
  const snap = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    let level = null;
    try {
      level = w.__echoLocalTrack?.getVolumeLevel?.() ?? null;
    } catch {}
    return {
      level,
      panel: document.body.innerText.includes("No speech captured"),
    };
  });
  process.stdout.write(
    `  t+${i * 5}s  mic=${snap.level === null ? "n/a" : snap.level.toFixed(3)}` +
      `  panel=${snap.panel ? "EMPTY" : "HAS CONTENT"}\n`,
  );
}

/* What the toolkit itself thinks its state is — the authoritative answer to
   "did we bind, and to which channel". */
const toolkit = await page.evaluate(() => {
  const w = /** @type {any} */ (window);
  const AI = w.AgoraVoiceAI ?? w.__AgoraVoiceAI;
  try {
    return AI?.getState?.() ?? "not exposed on window";
  } catch (e) {
    return `getState threw: ${String(e)}`;
  }
});

const count = (re) => lines.filter((l) => re.test(l)).length;
console.log("\n  ── chain ──────────────────────────────────────────────");
console.log(`  audio PTS enabled      ${count(/audio PTS enabled/i) ? "YES" : "NO"}`);
console.log(`  rtm subscribed         ${count(/\[agora rtm\] subscribed/i) ? "YES" : "NO"}`);
console.log(`  toolkit subscribed     ${count(/transcript layer ready/i) ? "YES" : "NO"}`);
console.log(`  TRANSCRIPT_UPDATED     ${count(/\[voice-agent\] update /i)} update(s)`);
console.log(`  NO TRANSCRIPT warnings ${count(/NO TRANSCRIPT/i)}`);
console.log(`  toolkit state          ${JSON.stringify(toolkit)}`);
console.log("  ───────────────────────────────────────────────────────\n");

await browser.close();
