// ============================================================
// Database layer — node:sqlite (built into Node 22+, zero deps).
// File-based by default so leads survive a server restart.
// ============================================================
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const { hashPassword, isHashed } = require("./auth");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "dance_lead_machine.db");
function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  admin_user TEXT NOT NULL DEFAULT 'admin',
  admin_password TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'studio',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
    CREATE TABLE IF NOT EXISTS instructors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      specialties TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, name)
    );
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      session_id TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      email TEXT,
      dance_interest TEXT,
      goal_notes TEXT,
      lead_source TEXT NOT NULL DEFAULT 'AI Receptionist (Website Chat)',
      pipeline_stage TEXT NOT NULL DEFAULT 'New Inquiry',
      date_added TEXT NOT NULL DEFAULT (datetime('now')),
      last_contact TEXT NOT NULL DEFAULT (datetime('now')),
      next_follow_up TEXT,
      assigned_instructor TEXT,
      recommended_product TEXT,
      potential_revenue REAL DEFAULT 0,
      engagement INTEGER DEFAULT 3,
      appointment_label TEXT,
      appointment_date TEXT,
      time_preference TEXT
    );
    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      lead_id INTEGER NOT NULL REFERENCES leads(id),
      template_key TEXT NOT NULL,
      template_label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sequence_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_id INTEGER NOT NULL REFERENCES sequences(id),
      send_date TEXT NOT NULL,
      send_date_sort TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
    );
    CREATE TABLE IF NOT EXISTS conversations (
      session_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT '{}',
      messages TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
  `);

  // Migration: add time_preference to existing databases that predate this column
  const leadCols = db.prepare("PRAGMA table_info(leads)").all();
  if (!leadCols.some((c) => c.name === "time_preference")) {
    db.exec("ALTER TABLE leads ADD COLUMN time_preference TEXT");
  }

  // Migration: add tenant_id to any pre-existing databases that predate
  // multi-tenancy. New installs get it from CREATE TABLE above already;
  // this only fires on databases created before this change shipped.
  for (const [table] of [["instructors"], ["leads"], ["sequences"], ["conversations"]]) {
    const tCols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!tCols.some((c) => c.name === "tenant_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);
    }
  }
// Migration: add account_type to the tenants table for databases
// that predate solo-instructor mode. Existing tenant rows default
// to their current ACCOUNT_TYPE env var value so nothing changes
// for them until they're switched in the database directly.
const tenantCols = db.prepare("PRAGMA table_info(tenants)").all();
if (!tenantCols.some((c) => c.name === "account_type")) {
  db.exec("ALTER TABLE tenants ADD COLUMN account_type TEXT NOT NULL DEFAULT 'studio'");
  db.prepare("UPDATE tenants SET account_type = ? WHERE id = 1").run(
    (process.env.ACCOUNT_TYPE || "studio").toLowerCase()
  );
}

// Migration: add billing/subscription columns to tenants for
// self-serve signup + Square subscriptions. Existing tenants
// (created manually before this) default to subscription_status
// 'active' so nothing about their access changes.
const tenantCols2 = db.prepare("PRAGMA table_info(tenants)").all();
const addTenantCol = (name, ddl) => {
  if (!tenantCols2.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE tenants ADD COLUMN ${ddl}`);
  }
};
addTenantCol("square_customer_id", "square_customer_id TEXT");
addTenantCol("square_subscription_id", "square_subscription_id TEXT");
addTenantCol("subscription_status", "subscription_status TEXT NOT NULL DEFAULT 'active'");
addTenantCol("trial_ends_at", "trial_ends_at TEXT");
addTenantCol("reset_token_hash", "reset_token_hash TEXT");
addTenantCol("reset_token_expires_at", "reset_token_expires_at TEXT");
addTenantCol("onboarding_completed", "onboarding_completed INTEGER NOT NULL DEFAULT 0");
addTenantCol("chosen_offer_key", "chosen_offer_key TEXT");
  // Ensure a default tenant (id 1) exists — this is "your" studio account,
  // and is where all pre-multi-tenancy data lives after migration above.
    const tenantCount = db.prepare("SELECT COUNT(*) AS n FROM tenants").get().n;
  if (tenantCount === 0) {
    db.prepare(
  "INSERT INTO tenants (id, name, admin_user, admin_password, account_type) VALUES (1, ?, ?, ?, ?)"
).run(
  process.env.STUDIO_NAME || "Dance Lead Machine Studio",
  process.env.ADMIN_USER || "admin",
  hashPassword(process.env.ADMIN_PASSWORD || ""),
  (process.env.ACCOUNT_TYPE || "studio").toLowerCase()
);
  }

  // Migration: hash any legacy plain-text admin_password values
  // already in the database. Existing credentials keep working —
  // we hash the value that's already there, so logins are unaffected.
  const allTenants = db.prepare("SELECT id, admin_password FROM tenants").all();
  for (const t of allTenants) {
    if (!isHashed(t.admin_password)) {
      db.prepare("UPDATE tenants SET admin_password = ? WHERE id = ?").run(
        hashPassword(t.admin_password),
        t.id
      );
    }
  }

  // Seed default instructors on first run — only for studio accounts.
  // A solo instructor doesn't need a team roster; leads are assigned
  // directly to the owner in server.js when ACCOUNT_TYPE=solo.
  const accountType = (process.env.ACCOUNT_TYPE || "studio").toLowerCase();
  if (accountType !== "solo") {
    const count = db.prepare("SELECT COUNT(*) AS n FROM instructors WHERE tenant_id = 1").get().n;
    if (count === 0) {
      const insert = db.prepare("INSERT INTO instructors (tenant_id, name, specialties, active) VALUES (1, ?, ?, 1)");
      insert.run("Robert", JSON.stringify(["competitive", "private"]));
      insert.run("Brigette", JSON.stringify(["wedding", "kids"]));
    }
  }
  const pcCols = db.prepare("PRAGMA table_info(pricing_categories)").all();
if (pcCols.length > 0 && !pcCols.some((c) => c.name === "tenant_id")) {
  db.exec(`
    CREATE TABLE pricing_categories_new (
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
    INSERT INTO pricing_categories_new (id, tenant_id, key, label, product, revenue, active, sort_order)
      SELECT id, 1, key, label, product, revenue, active, sort_order FROM pricing_categories;
    DROP TABLE pricing_categories;
    ALTER TABLE pricing_categories_new RENAME TO pricing_categories;
  `);
}
  return db;
}
module.exports = { openDb, DB_PATH };
