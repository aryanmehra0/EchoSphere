import { chromium } from "playwright-core";
import path from "node:path";

async function main() {
  // Find local Chrome or Edge
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err));

  console.log("Navigating to http://localhost:3000...");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // 1. Select scenario: E-Commerce Checkout Degradation
  console.log("Selecting scenario...");
  const scenarioBtn = await page.$("button:has-text('Scenario:'), button:has-text('Live Speech')");
  if (scenarioBtn) {
    await scenarioBtn.click();
    await page.waitForTimeout(500);
    const ecommerceOpt = await page.$("text=E-Commerce Checkout Degradation");
    if (ecommerceOpt) {
      await ecommerceOpt.click();
      await page.waitForTimeout(1000);
    }
  }

  // 2. Click on "Theories" tab in the Intel Column
  console.log("Switching to Theories tab...");
  const theoriesTab = await page.$("button[role='tab']:has-text('Theories')");
  if (theoriesTab) {
    await theoriesTab.click();
    await page.waitForTimeout(1000);
  }

  // Save screenshot 1
  const outPath1 = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_theories_matrix.png";
  await page.screenshot({ path: outPath1 });
  console.log("Screenshot saved to", outPath1);

  // 3. Click "Run Probe" button on the open theory
  console.log("Triggering Run Probe on open theory...");
  const probeBtn = await page.$("button:has-text('Run Probe')");
  if (probeBtn) {
    await probeBtn.click();
    console.log("Clicked probe button, waiting for refutation transition...");
    try {
      await page.waitForSelector("text=REFUTED", { timeout: 8000 });
      console.log("Found REFUTED badge!");
    } catch {
      console.log("Timeout waiting for REFUTED badge, waiting 3s...");
      await page.waitForTimeout(3000);
    }
  }

  // Save screenshot 2
  const outPath2 = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_theories_probed.png";
  await page.screenshot({ path: outPath2 });
  console.log("Screenshot 2 saved to", outPath2);

  await browser.close();
  console.log("Done!");
}

main().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
