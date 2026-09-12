import { chromium } from "playwright-core";

async function main() {
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
  await page.waitForTimeout(1500);

  // 1. Screenshot CommandBar with Project and Connectors badge
  const outMain = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_project_commandbar.png";
  await page.screenshot({ path: outMain });
  console.log("Main command bar screenshot saved:", outMain);

  // 2. Open Project Workspace Modal by clicking the Workspace button or Project badge
  console.log("Opening Project Workspace Modal...");
  const workspaceBtn = await page.$("button:has-text('Workspace')");
  if (workspaceBtn) {
    await workspaceBtn.click();
  } else {
    const projBadge = await page.$("button:has-text('Payments')");
    if (projBadge) await projBadge.click();
  }

  await page.waitForTimeout(1000);

  // 3. Screenshot Connectors Tab
  const outConnectors = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_project_connectors.png";
  await page.screenshot({ path: outConnectors });
  console.log("Connectors tab screenshot saved:", outConnectors);

  // 4. Click [Test Connection] on Prometheus connector
  console.log("Testing Prometheus connection...");
  const testButtons = await page.$$("button:has-text('Test Connection')");
  if (testButtons.length > 0) {
    await testButtons[0].click();
    await page.waitForTimeout(1500);
  }

  const outTested = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_project_connector_tested.png";
  await page.screenshot({ path: outTested });
  console.log("Tested connector screenshot saved:", outTested);

  // 5. Switch to Team & Responders Tab
  console.log("Switching to Team & Responders tab...");
  const teamTab = await page.$("button[role='tab']:has-text('Team')");
  if (teamTab) {
    await teamTab.click();
    await page.waitForTimeout(800);
  }

  const outTeam = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_project_team.png";
  await page.screenshot({ path: outTeam });
  console.log("Team tab screenshot saved:", outTeam);

  // 6. Switch to War Rooms & Channels Tab
  console.log("Switching to War Rooms & Channels tab...");
  const warRoomsTab = await page.$("button[role='tab']:has-text('War Rooms')");
  if (warRoomsTab) {
    await warRoomsTab.click();
    await page.waitForTimeout(800);
  }

  const outWarRooms = "C:\\Users\\Harsh\\.gemini\\antigravity\\brain\\693b8a83-5513-4261-abcd-9ef42a6d62d7\\console_project_warrooms.png";
  await page.screenshot({ path: outWarRooms });
  console.log("War Rooms tab screenshot saved:", outWarRooms);

  await browser.close();
  console.log("Visual verification complete!");
}

main().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
