// ============================================================
// Database layer — node:sqlite (built into Node 22+, zero deps).
// File-based by default so leads survive a server restart.
// ============================================================
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "dance_lead_machine.db");

function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS instructors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      specialties TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      appointment_date TEXT
    );

    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      state TEXT NOT NULL DEFAULT '{}',
      messages TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed default instructors on first run
  const count = db.prepare("SELECT COUNT(*) AS n FROM instructors").get().n;
  if (count === 0) {
    const insert = db.prepare("INSERT INTO instructors (name, specialties, active) VALUES (?, ?, 1)");
    insert.run("Robert", JSON.stringify(["competitive", "private"]));
    insert.run("Brigette", JSON.stringify(["wedding", "kids"]));
  }

  return db;
}

module.exports = { openDb, DB_PATH };
