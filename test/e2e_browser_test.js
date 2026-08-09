// ============================================================
// End-to-end test: real server (mocked Anthropic) + real browser
// via Playwright, driving the actual frontend UI.
// ============================================================
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const TEST_DB = path.join(__dirname, "e2e.db");
for (const ext of ["", "-shm", "-wal"]) {
  const f = TEST_DB + ext;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TEST_DB;
process.env.PORT = "8936";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.STUDIO_NAME = "Test Dance Studio";

const realFetch = global.fetch;
let scriptQueue = [];
global.fetch = async (url, opts) => {
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    const step = scriptQueue.shift();
    if (!step) throw new Error("Mock Anthropic: no more scripted responses queued");
    const content = [];
    if (step.text) content.push({ type: "text", text: step.text });
    if (step.toolCall) content.push({ type: "tool_use", id: "x", name: "capture_lead", input: step.toolCall });
    return { ok: true, status: 200, json: async () => ({ content }) };
  }
  return realFetch(url, opts);
};

const { server } = require("../src/server");

function queueWeddingScript() {
  scriptQueue.push({ text: "How exciting — congratulations! When's the big day, and have you danced together before?" });
  scriptQueue.push({ text: "Perfect, thank you! What's your name?" });
  scriptQueue.push({ text: "Nice to meet you! What's the best phone or email to reach you at?" });
  scriptQueue.push({ text: "Great, here's what I have open:\n1) Tomorrow at 10:00 AM\n2) Tomorrow at 3:30 PM\n3) Monday at 5:00 PM\nWhich works best?" });
  scriptQueue.push({
    text: "You're all set! We'll see you then.",
    toolCall: { name: "Jessica Martinez", contact: "jessica.m@email.com", category: "wedding", notes: "Wedding Oct 17th.", slot_choice: 1 },
  });
}

async function main() {
  await new Promise((resolve) => server.listen(process.env.PORT, resolve));
  const base = `http://localhost:${process.env.PORT}`;
  console.log(`E2E server listening on ${base}`);

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e}`));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`CONSOLE: ${m.text()}`); });

  await page.goto(base);
  await page.waitForTimeout(500);

  const badge = await page.textContent("#liveBadge");
  console.log("Live badge:", badge);

  queueWeddingScript();
  const turns = [
    "My fiancé and I need help with our first dance for our wedding in October.",
    "October 17th, never danced together.",
    "Jessica Martinez",
    "jessica.m@email.com",
    "1",
  ];
  for (const msg of turns) {
    await page.fill("#input", msg);
    await page.click("#sendBtn");
    await page.waitForTimeout(500);
  }

  const leadCount = await page.textContent("#leadCount");
  console.log("Lead count after conversation:", leadCount);

  const leadCardText = await page.locator(".lead-card").last().textContent();
  console.log("Lead card:", leadCardText.replace(/\s+/g, " ").trim());

  // Switch to follow-up tab
  await page.click("#tabBtnFollowup");
  await page.waitForTimeout(300);
  const fuCount = await page.textContent("#fuCount");
  console.log("Follow-up step count:", fuCount);
  const timelineCards = await page.locator(".lead-timeline-card").count();
  console.log("Timeline cards:", timelineCards);

  // Switch to team tab
  await page.click("#tabBtnTeam");
  await page.waitForTimeout(300);
  const instructorCards = await page.locator(".instructor-card").count();
  console.log("Instructor cards:", instructorCards);
  const brigetteCard = await page.locator(".instructor-card", { hasText: "Brigette" }).textContent();
  console.log("Brigette card:", brigetteCard.replace(/\s+/g, " ").trim());

  // Add a new instructor via the UI
  await page.fill("#newInstructorName", "Nina");
  await page.check("#spec_wedding");
  await page.click("#addInstructorBtn");
  await page.waitForTimeout(400);
  const rosterCount = await page.textContent("#teamRosterCount");
  console.log("Roster count after adding Nina:", rosterCount);

  // Refresh the page — leads should persist (real DB!)
  await page.reload();
  await page.waitForTimeout(500);
  const leadCountAfterReload = await page.textContent("#leadCount");
  console.log("Lead count after page reload (should persist):", leadCountAfterReload);

  console.log("\nConsole/page errors:", consoleErrors.length ? consoleErrors : "none");

  await browser.close();
  server.close();
  process.exit(consoleErrors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});
