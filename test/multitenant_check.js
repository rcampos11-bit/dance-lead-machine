const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert");

const TEST_DB = path.join(__dirname, "test_multitenant.db");
for (const ext of ["", "-shm", "-wal"]) {
  const f = TEST_DB + ext;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TEST_DB;
process.env.PORT = "8937";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.STUDIO_NAME = "Country & West Coast Swing Dance"; // tenant 1's real name

const realFetch = global.fetch;
let scriptQueue = [];
global.fetch = async (url, opts) => {
  if (typeof url === "string" && url.includes("api.anthropic.com")) {
    const step = scriptQueue.shift();
    const content = [];
    if (step.text) content.push({ type: "text", text: step.text });
    if (step.toolCall) content.push({ type: "tool_use", id: "x", name: "capture_lead", input: step.toolCall });
    // Also capture the system prompt that was actually sent, so we can
    // assert on which studio name the AI was told to use.
    const bodyParsed = JSON.parse(opts.body);
    lastSystemPrompt = bodyParsed.system;
    return { ok: true, status: 200, json: async () => ({ content }) };
  }
  return realFetch(url, opts);
};
let lastSystemPrompt = "";

const { openDb, generateUniqueSlug } = require("../src/db");
const seedDb = openDb();
seedDb.exec(`
  CREATE TABLE IF NOT EXISTS pricing_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL, label TEXT NOT NULL, product TEXT NOT NULL,
    revenue REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tenant_id, key)
  );
`);
seedDb.prepare(
  "INSERT OR IGNORE INTO pricing_categories (tenant_id, key, label, product, revenue, active, sort_order) VALUES (1, 'wedding', 'Wedding Dance', 'Wedding Package', 900, 1, 0)"
).run();

// Create a SECOND tenant directly (simulating a real second customer who
// signed up), with its own slug and its own pricing category.
const secondTenantSlug = generateUniqueSlug(seedDb, "Sarah's Salsa Studio");
const secondTenantInfo = seedDb
  .prepare("INSERT INTO tenants (name, admin_user, admin_password, account_type, slug) VALUES (?, 'sarah@example.com', 'x', 'solo', ?)")
  .run("Sarah's Salsa Studio", secondTenantSlug);
const secondTenantId = secondTenantInfo.lastInsertRowid;
seedDb.prepare(
  "INSERT OR IGNORE INTO pricing_categories (tenant_id, key, label, product, revenue, active, sort_order) VALUES (?, 'wedding', 'Wedding Dance', 'Salsa Wedding Package', 700, 1, 0)"
).run(secondTenantId);

// A THIRD tenant with no texting set up — used to prove texting is
// gated per business (no consent card, no text steps, email-only).
const thirdTenantSlug = generateUniqueSlug(seedDb, "Tango Corner");
const thirdTenantId = seedDb
  .prepare("INSERT INTO tenants (name, admin_user, admin_password, account_type, slug) VALUES (?, 'tango@example.com', 'x', 'solo', ?)")
  .run("Tango Corner", thirdTenantSlug).lastInsertRowid;
seedDb.prepare(
  "INSERT OR IGNORE INTO pricing_categories (tenant_id, key, label, product, revenue, active, sort_order) VALUES (?, 'wedding', 'Wedding Dance', 'Tango Wedding Package', 700, 1, 0)"
).run(thirdTenantId);

// Texting enabled for tenant 1 and the second tenant only (not the third).
process.env.SMS_ENABLED_TENANT_IDS = `1,${secondTenantId}`;

const { server } = require("../src/server");
let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); passed++; }
  catch (e) { console.log(`  FAIL  ${label}\n        ${e.message}`); failed++; }
}
const BASE = `http://localhost:${process.env.PORT}`;
async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  return { status: res.status, data: isJson ? await res.json() : await res.text() };
}

async function main() {
  await new Promise((resolve) => server.listen(process.env.PORT, resolve));
  console.log(`Test server listening on ${BASE}\n`);
  console.log(`Second tenant slug generated: ${secondTenantSlug}\n`);

  // ---- Scenario A: no slug at all -> safe demo response, no data written ----
  console.log("== No slug in URL: shows a safe demo message, touches no real tenant's data ==");
  {
    const r = await api("POST", "/api/chat", { sessionId: "tenant-test-1", message: "hello" });
    check("request succeeds with no tenantSlug", () => assert.strictEqual(r.status, 200));
    check("response is flagged as a demo", () => assert.strictEqual(r.data.isDemo, true));
    check("no AI call was made (scriptQueue untouched)", () => assert.strictEqual(scriptQueue.length, 0));
    const { openDb } = require("../src/db");
    const db = openDb();
    const convo = db.prepare("SELECT tenant_id FROM conversations WHERE session_id = ?").get("tenant-test-1");
    check("no conversation row was created for the no-slug request", () => assert.strictEqual(convo, undefined));
  }

  // ---- Scenario B: valid slug for tenant 2 -> resolves correctly, sees ITS OWN name/pricing ----
  console.log("\n== Valid slug for second tenant: fully isolated ==");
  {
    scriptQueue.push({ text: "Hi! What can I help with?" });
    const r = await api("POST", "/api/chat", {
      sessionId: "tenant-test-2",
      message: "hello",
      tenantSlug: secondTenantSlug,
    });
    check("request succeeds with valid tenantSlug", () => assert.strictEqual(r.status, 200));
    check("AI system prompt uses SECOND tenant's real name, not tenant 1's", () => {
      assert.ok(lastSystemPrompt.includes("Sarah's Salsa Studio"));
      assert.ok(!lastSystemPrompt.includes("Country & West Coast Swing Dance"));
    });
    check("AI system prompt uses SECOND tenant's own pricing category, not tenant 1's", () => {
      assert.ok(lastSystemPrompt.includes("Salsa Wedding Package") || lastSystemPrompt.includes("wedding"));
    });
    const { openDb } = require("../src/db");
    const db = openDb();
    const convo = db.prepare("SELECT tenant_id FROM conversations WHERE session_id = ?").get("tenant-test-2");
    check("conversation stored against the correct second tenant, not tenant 1", () =>
      assert.strictEqual(convo.tenant_id, secondTenantId)
    );
  }

  // ---- Scenario C: unknown/bogus slug -> clean 404, does not silently fall back to tenant 1 ----
  console.log("\n== Unknown slug: fails loudly instead of silently leaking into tenant 1 ==");
  {
    const r = await api("POST", "/api/chat", {
      sessionId: "tenant-test-3",
      message: "hello",
      tenantSlug: "this-slug-does-not-exist",
    });
    check("unknown slug returns 404, not a silent fallback", () => assert.strictEqual(r.status, 404));
    const { openDb } = require("../src/db");
    const db = openDb();
    const convo = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get("tenant-test-3");
    check("no conversation row was created for the invalid slug", () => assert.strictEqual(convo, undefined));
  }

  // ---- Scenario D: SMS consent disclosure uses the SECOND tenant's real name ----
  console.log("\n== SMS consent disclosure shows the correct tenant's business name ==");
  {
    scriptQueue.push({
      text: "Got it, thanks!",
      toolCall: {
        name: "Maria Lopez",
        phone: "480-555-2222",
        email: "",
        category: "wedding",
        notes: "Wedding in October.",
        time_preference: "evening",
      },
    });
    const r = await api("POST", "/api/chat", {
      sessionId: "tenant-test-4",
      message: "wedding help, I'm Maria, 480-555-2222",
      tenantSlug: secondTenantSlug,
    });
    check("awaitingConsent block present", () => assert.ok(r.data.awaitingConsent));
    check("consent disclosure names the SECOND tenant's studio, not tenant 1's", () => {
      assert.ok(r.data.awaitingConsent.disclosure.includes("Sarah&#39;s Salsa Studio"));
      assert.ok(!r.data.awaitingConsent.disclosure.includes("Country & West Coast Swing Dance"));
    });
    check("consent studioName field matches too", () =>
      assert.strictEqual(r.data.awaitingConsent.studioName, "Sarah's Salsa Studio")
    );
  }

  // ---- Scenario E: a business WITHOUT texting set up never gets SMS ----
  console.log("\n== Business without texting: no consent card, email-only ==");
  {
    scriptQueue.push({
      text: "Got it, thanks!",
      toolCall: {
        name: "Leo Park",
        phone: "480-555-3333",
        email: "leo@example.com",
        category: "wedding",
        notes: "Wedding in May.",
        time_preference: "morning",
      },
    });
    const r = await api("POST", "/api/chat", {
      sessionId: "tenant-test-5",
      message: "wedding help, I'm Leo, 480-555-3333, leo@example.com",
      tenantSlug: thirdTenantSlug,
    });
    check("no SMS consent card for a business without texting", () => assert.ok(!r.data.awaitingConsent));
    check("lead is saved right away", () => assert.ok(r.data.done && r.data.lead));
    const { openDb: open2 } = require("../src/db");
    const db2 = open2();
    const lead = db2.prepare("SELECT * FROM leads WHERE session_id = ?").get("tenant-test-5");
    check("lead belongs to the third business", () => assert.strictEqual(lead.tenant_id, thirdTenantId));
    check("phone number is still saved", () => assert.strictEqual(lead.phone, "480-555-3333"));
    const textSteps = db2.prepare(
      "SELECT COUNT(*) n FROM sequence_steps ss JOIN sequences s ON s.id = ss.sequence_id WHERE s.lead_id = ? AND ss.channel = 'text'"
    ).get(lead.id).n;
    check("no text messages scheduled", () => assert.strictEqual(textSteps, 0));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
