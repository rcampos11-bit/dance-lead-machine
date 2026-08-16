// ============================================================
// Dance Lead Machine — real connected AI Receptionist server.
// Zero external dependencies: node:http, node:sqlite, native fetch.
// ============================================================
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const { Router, sendJson, sendText, serveStatic } = require("./router");
const { openDb } = require("./db");
const { getReceptionistReply } = require("./ai");
const {
  generateSlots,
  pickInstructor,
  generateSequenceSteps,
} = require("./logic");
const {
  getCategories,
  getCategoryForKey,
  addCategory,
  updateCategory,
  deleteCategory,
} = require("./pricing");
const { sendSms, sendEmail } = require("./notify");

const PORT = process.env.PORT || 3000;
const STUDIO_NAME = process.env.STUDIO_NAME || "Dance Lead Machine Studio";
const ACCOUNT_TYPE = (process.env.ACCOUNT_TYPE || "studio").toLowerCase(); // "solo" or "studio"
const OWNER_NAME = process.env.OWNER_NAME || STUDIO_NAME;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const db = openDb();
const router = new Router();
const staticHandler = serveStatic(PUBLIC_DIR);

// ---- admin auth helpers ----
function isAdminPath(pathname) {
  if (pathname === "/admin.html") return true;
  const adminApiPrefixes = [
    "/api/leads",
    "/api/sequences",
    "/api/instructors",
    "/api/setmore",
    "/api/pricing",
  ];
  return adminApiPrefixes.some(
    (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + ".")
  );
}

function checkAdminAuth(req) {
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  const tenant = db
    .prepare("SELECT * FROM tenants WHERE admin_user = ? AND admin_password = ?")
    .get(user, pass);
  return tenant || null;
}

// ---- helpers ----
function extractContact(text) {
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = text.match(/(\+?\d[\d\-.\s()]{7,}\d)/);
  return {
    email: emailMatch ? emailMatch[0] : "",
    phone: phoneMatch ? phoneMatch[0].trim() : "",
  };
}
function to24Hour(timeStr) {
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return timeStr;
  let [, hour, minute, period] = match;
  hour = parseInt(hour, 10);
  if (period.toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (period.toUpperCase() === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}
function addMinutes(dateTimeStr, minutes) {
  const [datePart, timePart] = dateTimeStr.split("T");
  const [h, m] = timePart.split(":").map(Number);
  const totalMinutes = h * 60 + m + minutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${datePart}T${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
}
function getRoster() {
  const rows = db.prepare("SELECT * FROM instructors").all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    specialties: JSON.parse(r.specialties || "[]"),
    active: !!r.active,
  }));
}

function getLoadByInstructor() {
  const rows = db
    .prepare(
      "SELECT assigned_instructor AS name, COUNT(*) AS n FROM leads WHERE pipeline_stage NOT IN ('Enrolled','Lost') GROUP BY assigned_instructor"
    )
    .all();
  const load = {};
  for (const r of rows) load[r.name] = r.n;
  return load;
}

function toAnthropicHistory(storedMessages) {
  return storedMessages;
}

// ============================================================
// POST /api/chat — the real AI conversation endpoint
// ============================================================
router.post("/api/chat", async ({ req, res, body }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const sessionId = body.sessionId || crypto.randomUUID();
  const userMessage = (body.message || "").toString().slice(0, 2000);

  if (!userMessage.trim()) {
    return sendJson(res, 400, { error: "message is required" });
  }

  let convo = db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(sessionId);
  let state, messages;
  if (!convo) {
    state = { slots: generateSlots(), done: false };
    messages = [];
    db.prepare("INSERT INTO conversations (session_id, state, messages) VALUES (?, ?, ?)").run(
      sessionId,
      JSON.stringify(state),
      JSON.stringify(messages)
    );
  } else {
    state = JSON.parse(convo.state);
    messages = JSON.parse(convo.messages);
    state.slots = (state.slots || []).map((s) => ({ ...s, dateObj: new Date(s.dateObj) }));
  }

  if (state.done) {
    return sendJson(res, 200, {
      sessionId,
      reply: "This conversation already wrapped up! Start a new chat to add another lead.",
      done: true,
    });
  }

  let aiResult;
  try {
    aiResult = await getReceptionistReply({
      apiKey,
      studioName: STUDIO_NAME,
      slots: state.slots,
      history: toAnthropicHistory(messages),
      userMessage,
    });
  } catch (err) {
    return sendJson(res, 502, { error: err.message, sessionId });
  }

  messages.push({ role: "user", content: userMessage });
  messages.push({ role: "assistant", content: aiResult.rawAssistantContent });

  let leadSummary = null;

  if (aiResult.toolCall) {
    const tc = aiResult.toolCall;
    const email = (tc.email || "").trim();
const phone = (tc.phone || "").trim();

    // Pricing categories are now database-backed and admin-editable
    // (see src/pricing.js) instead of the old hardcoded CATEGORIES map
    // in logic.js. getCategoryForKey falls back to any active category
    // if the AI's chosen key no longer exists (renamed/removed), and
    // returns null only if there are zero active categories at all.
    const cat = getCategoryForKey(db, tc.category);
    if (!cat) {
      return sendJson(res, 500, {
        error: "No active pricing categories are configured. Add one in the admin Pricing tab.",
        sessionId,
      });
    }

    const timePreference = tc.time_preference || null;

    let instructor;
    if (ACCOUNT_TYPE === "solo") {
      instructor = OWNER_NAME;
    } else {
      const roster = getRoster();
      const load = getLoadByInstructor();
      instructor = pickInstructor(tc.category, roster, load);
    }

    const leadRow = {
  name: tc.name,
  email,
  phone,
  recommendedProduct: cat.product,
  assignedInstructor: instructor,
  appointment: null,
};

    let notes = tc.notes || "";
    notes += timePreference
      ? ` | Prefers ${timePreference} for a callback.`
      : ` | No time-of-day preference given — needs a personal follow-up to schedule.`;

    const insertLead = db.prepare(`
  INSERT INTO leads (
    session_id, name, phone, email, dance_interest, goal_notes, lead_source,
    pipeline_stage, next_follow_up, assigned_instructor, recommended_product,
    potential_revenue, engagement, appointment_label, appointment_date, time_preference
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
    const info = insertLead.run(
      sessionId,
      tc.name,
      phone,
      email,
      cat.label,
      notes,
      "AI Receptionist (Website Chat)",
      "Qualified",
      null,
      instructor,
      cat.product,
      cat.revenue,
      4,
      null,
      null,
      timePreference
    );
    const leadId = info.lastInsertRowid;

    const templateKey = "new_inquiry_no_response";
    const steps = generateSequenceSteps(leadRow, templateKey, null);
    const insertSeq = db.prepare(
      "INSERT INTO sequences (lead_id, template_key, template_label) VALUES (?, ?, ?)"
    );
    const seqInfo = insertSeq.run(leadId, templateKey, steps.length ? templateKeyLabel(templateKey) : templateKey);
    const insertStep = db.prepare(
      "INSERT INTO sequence_steps (sequence_id, send_date, send_date_sort, channel, body, status) VALUES (?,?,?,?,?,?)"
    );
    for (const s of steps) {
      insertStep.run(seqInfo.lastInsertRowid, s.dateStr, s.sortKey, s.channel, s.body, s.status);
    }

    state.done = true;
    state.leadId = leadId;

    leadSummary = {
  id: leadId,
  name: tc.name,
  email,
  phone,
  danceInterest: cat.label,
  recommendedProduct: cat.product,
  potentialRevenue: cat.revenue,
  assignedInstructor: instructor,
  pipelineStage: "Qualified",
  timePreference,
};
  }

  db.prepare("UPDATE conversations SET state = ?, messages = ?, updated_at = datetime('now') WHERE session_id = ?").run(
    JSON.stringify(state),
    JSON.stringify(messages),
    sessionId
  );

  sendJson(res, 200, {
    sessionId,
    reply: aiResult.reply,
    done: state.done,
    lead: leadSummary,
  });
});

function templateKeyLabel(key) {
  const { SEQUENCE_TEMPLATES } = require("./logic");
  return (SEQUENCE_TEMPLATES[key] && SEQUENCE_TEMPLATES[key].label) || key;
}

// ============================================================
// Leads
// ============================================================
router.get("/api/leads", async ({ res }) => {
  const rows = db.prepare("SELECT * FROM leads ORDER BY id DESC").all();
  sendJson(res, 200, rows);
});

router.get("/api/leads.csv", async ({ res }) => {
  const rows = db.prepare("SELECT * FROM leads ORDER BY id ASC").all();
  const headers = [
    "Date Added", "Name", "Phone", "Email", "Dance Interest", "Goal / Notes",
    "Lead Source", "Pipeline Stage", "Last Contact", "Next Follow-Up",
    "Assigned Instructor", "Recommended Product", "Potential Revenue ($)", "Engagement (1-5)",
  ];
  const csvRows = rows.map((r) => [
    r.date_added, r.name, r.phone, r.email, r.dance_interest, r.goal_notes,
    r.lead_source, r.pipeline_stage, r.last_contact, r.next_follow_up,
    r.assigned_instructor, r.recommended_product, r.potential_revenue, r.engagement,
  ]);
  const csv = [headers, ...csvRows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="leads.csv"',
  });
  res.end(csv);
});

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ============================================================
// Sequences (follow-up)
// ============================================================
router.get("/api/sequences", async ({ res }) => {
  const seqs = db.prepare("SELECT * FROM sequences ORDER BY id DESC").all();
  const result = seqs.map((seq) => {
    const lead = db.prepare("SELECT name FROM leads WHERE id = ?").get(seq.lead_id);
    const steps = db
      .prepare("SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY send_date_sort ASC")
      .all(seq.id);
    return {
      id: seq.id,
      leadId: seq.lead_id,
      leadName: lead ? lead.name : "(unknown)",
      templateKey: seq.template_key,
      templateLabel: seq.template_label,
      steps,
    };
  });
  sendJson(res, 200, result);
});

router.post("/api/sequences/simulate", async ({ res, body }) => {
  const { leadId, templateKey } = body;
  const leadRowRaw = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!leadRowRaw) return sendJson(res, 404, { error: "Lead not found" });

  const leadRow = {
  name: leadRowRaw.name,
  email: leadRowRaw.email,
  phone: leadRowRaw.phone,
  recommendedProduct: leadRowRaw.recommended_product,
  assignedInstructor: leadRowRaw.assigned_instructor,
  appointment: leadRowRaw.appointment_label,
};
  const apptDate = leadRowRaw.appointment_date ? new Date(leadRowRaw.appointment_date) : null;
  const steps = generateSequenceSteps(leadRow, templateKey, apptDate);
  const insertSeq = db.prepare(
    "INSERT INTO sequences (lead_id, template_key, template_label) VALUES (?, ?, ?)"
  );
  const info = insertSeq.run(leadId, templateKey, templateKeyLabel(templateKey));
  const insertStep = db.prepare(
    "INSERT INTO sequence_steps (sequence_id, send_date, send_date_sort, channel, body, status) VALUES (?,?,?,?,?,?)"
  );
  for (const s of steps) insertStep.run(info.lastInsertRowid, s.dateStr, s.sortKey, s.channel, s.body, s.status);

  sendJson(res, 200, { ok: true, sequenceId: info.lastInsertRowid });
});

// ============================================================
// Instructors / Studio Team
// ============================================================
router.get("/api/instructors", async ({ res }) => {
  sendJson(res, 200, getRoster());
});

router.post("/api/instructors", async ({ res, body }) => {
  const { name, specialties } = body;
  if (!name || !name.trim()) return sendJson(res, 400, { error: "name is required" });
  try {
    db.prepare("INSERT INTO instructors (name, specialties, active) VALUES (?, ?, 1)").run(
      name.trim(),
      JSON.stringify(specialties || [])
    );
    sendJson(res, 201, { ok: true });
  } catch (e) {
    sendJson(res, 409, { error: "An instructor with that name already exists" });
  }
});

router.patch("/api/instructors/:id", async ({ res, params, body }) => {
  const fields = [];
  const values = [];
  if (typeof body.name === "string" && body.name.trim()) {
    fields.push("name = ?");
    values.push(body.name.trim());
  }
  if (typeof body.active === "boolean") {
    fields.push("active = ?");
    values.push(body.active ? 1 : 0);
  }
  if (Array.isArray(body.specialties)) {
    fields.push("specialties = ?");
    values.push(JSON.stringify(body.specialties));
  }
  if (fields.length === 0) return sendJson(res, 400, { error: "Nothing to update" });
  values.push(params.id);
  try {
    db.prepare(`UPDATE instructors SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 409, { error: "An instructor with that name already exists" });
  }
});

router.delete("/api/instructors/:id", async ({ res, params }) => {
  db.prepare("DELETE FROM instructors WHERE id = ?").run(params.id);
  sendJson(res, 200, { ok: true });
});

// ============================================================
// Pricing (admin-editable dance categories & rates)
// ============================================================
router.get("/api/pricing", async ({ res }) => {
  sendJson(res, 200, getCategories(db));
});

router.post("/api/pricing", async ({ res, body }) => {
  try {
    const id = addCategory(db, body || {});
    sendJson(res, 201, { ok: true, id });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

router.patch("/api/pricing/:id", async ({ res, params, body }) => {
  const updated = updateCategory(db, params.id, body || {});
  if (!updated) return sendJson(res, 400, { error: "Nothing to update" });
  sendJson(res, 200, { ok: true });
});

router.delete("/api/pricing/:id", async ({ res, params }) => {
  deleteCategory(db, params.id);
  sendJson(res, 200, { ok: true });
});

// ============================================================
// Setmore diagnostic — one-time use to discover staff/service keys
// ============================================================
router.get("/api/setmore/diagnostic", async ({ res }) => {
  try {
    const setmore = require("./setmore");
    const refreshToken = process.env.SETMORE_REFRESH_TOKEN;
    const [staff, services] = await Promise.all([
      setmore.listStaff(refreshToken),
      setmore.listServices(refreshToken),
    ]);
    sendJson(res, 200, { staff, services });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// ============================================================
// Health check (no API key needed — useful to verify deployment)
// ============================================================
router.get("/api/health", async ({ res }) => {
  sendJson(res, 200, {
    ok: true,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    studioName: STUDIO_NAME,
    accountType: ACCOUNT_TYPE,
    hasTwilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
    hasSendGrid: !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL),
    time: new Date().toISOString(),
  });
});

// ============================================================
// Scheduler — the piece that actually sends what sequence_steps
// only used to schedule. Runs on an interval inside this process;
// no external cron needed since this server stays up 24/7 on
// Render. Picks up any step that's due (send_date_sort <= today)
// and still marked "scheduled", sends it via Twilio or SendGrid
// depending on channel, and flips it to "sent" only on success —
// a failed send is left "scheduled" so the next tick retries it.
// ============================================================
async function processDueSends() {
  const today = new Date().toISOString().slice(0, 10);
  const dueSteps = db
    .prepare(
      `SELECT ss.*, s.lead_id
       FROM sequence_steps ss
       JOIN sequences s ON s.id = ss.sequence_id
       WHERE ss.status = 'scheduled' AND ss.send_date_sort <= ?`
    )
    .all(today);

  for (const step of dueSteps) {
    const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(step.lead_id);
    if (!lead) continue;

    try {
      if (step.channel === "text") {
        await sendSms({ to: lead.phone, body: step.body });
      } else if (step.channel === "email") {
        await sendEmail({ to: lead.email, subject: `A message from ${STUDIO_NAME}`, body: step.body });
      } else {
        continue;
      }
      db.prepare("UPDATE sequence_steps SET status = 'sent' WHERE id = ?").run(step.id);
    } catch (err) {
      console.warn(`Send failed for sequence_step ${step.id} (lead ${step.lead_id}, ${step.channel}): ${err.message}`);
      // Left as "scheduled" — picked up again on the next tick.
    }
  }

  return dueSteps.length;
}

// Manual trigger — useful for testing without waiting for the interval.
router.post("/api/sequences/process-due", async ({ res }) => {
  try {
    const count = await processDueSends();
    sendJson(res, 200, { ok: true, checked: count });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});


const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  if (isAdminPath(pathname)) {
  const tenant = checkAdminAuth(req);
  if (!tenant) {
    res.writeHead(401, {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="Studio Admin"',
    });
    return res.end("Authentication required");
  }
  req.tenantId = tenant.id;
}

  const handled = await router.handle(req, res);
  if (handled) return;

  const servedStatic = staticHandler(req, res);
  if (servedStatic) return;

  sendText(res, 404, "Not found");
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Dance Lead Machine server listening on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("WARNING: ANTHROPIC_API_KEY is not set. /api/chat will fail until it is.");
    }
    
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.SENDGRID_API_KEY) {
      console.warn("WARNING: Twilio and/or SendGrid are not fully configured. Scheduled sends will be checked but will fail until credentials are set.");
    }
    // Check for due sends every 5 minutes. Also run once shortly after
    // boot so a step that came due while the server was down doesn't
    // wait a full 5 minutes after restart.
    setTimeout(() => processDueSends().catch((e) => console.warn("processDueSends error:", e.message)), 15000);
    setInterval(() => {
      processDueSends().catch((e) => console.warn("processDueSends error:", e.message));
    }, 5 * 60 * 1000);
  });
}

module.exports = { server, db };
