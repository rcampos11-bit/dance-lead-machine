const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert");

const TEST_DB = path.join(__dirname, "test_sms_consent.db");
for (const ext of ["", "-shm", "-wal"]) {
  const f = TEST_DB + ext;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
process.env.DB_PATH = TEST_DB;
process.env.PORT = "8935";
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
    if (step.toolCall) {
      content.push({ type: "tool_use", id: "toolu_x", name: "capture_lead", input: step.toolCall });
    }
    return { ok: true, status: 200, json: async () => ({ content }) };
  }
  return realFetch(url, opts);
};

const { openDb } = require("../src/db");
const seedDb = openDb();
seedDb.exec(`
  CREATE TABLE IF NOT EXISTS pricing_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    product TEXT NOT NULL,
    revenue REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tenant_id, key)
  );
`);
seedDb.prepare(
  "INSERT OR IGNORE INTO pricing_categories (tenant_id, key, label, product, revenue, active, sort_order) VALUES (1, 'wedding', 'Wedding Dance', 'Wedding Package (Private Lessons)', 900, 1, 0)"
).run();

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

  // ---- Scenario A: phone given -> should NOT insert lead yet, should ask for consent ----
  console.log("== Phone given: consent gate should trigger ==");
  {
    scriptQueue.push({
      text: "Got it — thanks Jessica! A real person will call you shortly to find a time that works.",
      toolCall: {
        name: "Jessica Martinez",
        phone: "480-555-1212",
        email: "",
        category: "wedding",
        notes: "Wedding on Oct 17th.",
        time_preference: "evening",
      },
    });
    const r = await api("POST", "/api/chat", { sessionId: "consent-test-1", message: "wedding dance help" });
    check("not done yet", () => assert.strictEqual(r.data.done, false));
    check("no lead in response", () => assert.strictEqual(r.data.lead, null));
    check("awaitingConsent block present", () => assert.ok(r.data.awaitingConsent));
    check("disclosure mentions studio name", () => assert.ok(r.data.awaitingConsent.disclosure.includes("Test Dance Studio")));
    check("disclosure mentions STOP/HELP", () => assert.ok(/STOP/.test(r.data.awaitingConsent.disclosure) && /HELP/.test(r.data.awaitingConsent.disclosure)));

    const leadsBefore = await api("GET", "/api/leads", null);
    // (unauthenticated — expect 401, just confirming no crash; real check is via DB below)
    const { openDb } = require("../src/db");
    const db = openDb();
    const row = db.prepare("SELECT * FROM leads WHERE session_id = ?").get("consent-test-1");
    check("lead NOT written to DB before consent answered", () => assert.strictEqual(row, undefined));

    // stray message while awaiting consent should not call the AI or insert anything
    const stray = await api("POST", "/api/chat", { sessionId: "consent-test-1", message: "hello?" });
    check("stray message while awaiting consent is deflected, not done", () => assert.strictEqual(stray.data.done, false));

    // now answer YES via the consent endpoint
    const consentRes = await api("POST", "/api/chat/consent", { sessionId: "consent-test-1", consent: true });
    check("consent endpoint returns done", () => assert.strictEqual(consentRes.data.done, true));
    check("lead returned with smsConsent yes", () => assert.strictEqual(consentRes.data.lead.smsConsent, "yes"));

    const row2 = db.prepare("SELECT * FROM leads WHERE session_id = ?").get("consent-test-1");
    check("lead now written to DB", () => assert.ok(row2));
    check("sms_consent stored as yes", () => assert.strictEqual(row2.sms_consent, "yes"));
    check("sms_consent_at is set", () => assert.ok(row2.sms_consent_at));
    check("phone stored correctly", () => assert.strictEqual(row2.phone, "480-555-1212"));
  }

  // ---- Scenario B: phone given, consent DECLINED ----
  console.log("\n== Phone given, consent declined ==");
  {
    scriptQueue.push({
      text: "Thanks Mike!",
      toolCall: {
        name: "Mike Chen",
        phone: "480-555-9999",
        email: "",
        category: "wedding",
        notes: "Wedding in June.",
        time_preference: "morning",
      },
    });
    await api("POST", "/api/chat", { sessionId: "consent-test-2", message: "wedding dance help" });
    const consentRes = await api("POST", "/api/chat/consent", { sessionId: "consent-test-2", consent: false });
    check("declined consent still finalizes the lead", () => assert.strictEqual(consentRes.data.done, true));
    check("smsConsent recorded as no", () => assert.strictEqual(consentRes.data.lead.smsConsent, "no"));

    const { openDb } = require("../src/db");
    const db = openDb();
    const row = db.prepare("SELECT * FROM leads WHERE session_id = ?").get("consent-test-2");
    check("sms_consent stored as no in DB", () => assert.strictEqual(row.sms_consent, "no"));
  }

  // ---- Scenario C: email only, no phone -> no consent gate at all ----
  console.log("\n== Email only, no phone: lead finalizes immediately, no consent gate ==");
  {
    scriptQueue.push({
      text: "Thanks!",
      toolCall: {
        name: "Priya Patel",
        phone: "",
        email: "priya@email.com",
        category: "wedding",
        notes: "Wedding in August.",
        time_preference: "afternoon",
      },
    });
    const r = await api("POST", "/api/chat", { sessionId: "consent-test-3", message: "wedding dance help" });
    check("done immediately (no phone -> no consent gate)", () => assert.strictEqual(r.data.done, true));
    check("no awaitingConsent block", () => assert.strictEqual(r.data.awaitingConsent, null));
    check("lead present", () => assert.ok(r.data.lead));

    const { openDb } = require("../src/db");
    const db = openDb();
    const row = db.prepare("SELECT * FROM leads WHERE session_id = ?").get("consent-test-3");
    check("sms_consent is NULL (never asked, no phone given)", () => assert.strictEqual(row.sms_consent, null));
    check("sms_consent_at is NULL", () => assert.strictEqual(row.sms_consent_at, null));
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
