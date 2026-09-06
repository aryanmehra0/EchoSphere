import { chromium } from "playwright-core";

const b = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const c = await b.newContext({ permissions: ["microphone"] });
const p = await c.newPage();

p.on("console", (m) => {
  const t = m.text();
  if (!/Agora-SDK/.test(t)) console.log(`[${m.type()}] ${t.slice(0, 240)}`);
});
p.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 240)}`));
p.on("requestfailed", (r) =>
  console.log(`[reqfail] ${r.failure()?.errorText} ${r.url().slice(0, 140)}`),
);
p.on("response", (r) => {
  if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url().slice(0, 140)}`);
});
p.on("websocket", (ws) => {
  console.log(`[ws] open ${ws.url().slice(0, 140)}`);
  ws.on("socketerror", (e) => console.log(`[ws error] ${e}`));
  ws.on("close", () => console.log(`[ws] closed ${ws.url().slice(0, 80)}`));
});

await p.goto(process.env.U, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4000);
console.log("--- pressing J ---");
await p.keyboard.press("j");
await p.waitForTimeout(20000);
await b.close();
