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
const { hashPassword, verifyPassword, hashResetToken } = require("./auth");
const { getOfferTemplates, getOfferByKey } = require("./onboarding");
const { createTrialSubscription } = require("./square");

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
  if (pathname === "/onboarding.html") return true;
  const adminApiPrefixes = [
    "/api/leads",
    "/api/sequences",
    "/api/instructors",
    "/api/setmore",
    "/api/pricing",
    "/api/me",
    "/api/onboarding",
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
  const user = decoded.slice(0, idx).trim().toLowerCase();
  const pass = decoded.slice(idx + 1);
  const tenant = db.prepare("SELECT * FROM tenants WHERE admin_user = ?").get(user);
  if (!tenant) return null;
  if (!verifyPassword(pass, tenant.admin_password)) return null;
  return tenant;
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
function getRoster(tenantId) {
  const rows = db.prepare("SELECT * FROM instructors WHERE tenant_id = ?").all(tenantId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    specialties: JSON.parse(r.specialties || "[]"),
    active: !!r.active,
  }));
}

function getLoadByInstructor(tenantId) {
  const rows = db
    .prepare(
      "SELECT assigned_instructor AS name, COUNT(*) AS n FROM leads WHERE tenant_id = ? AND pipeline_stage NOT IN ('Enrolled','Lost') GROUP BY assigned_instructor"
    )
    .all(tenantId);
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

  const tenantId = 1; // public chat widget isn't tenant-aware yet — revisit when there's a second customer
let convo = db.prepare("SELECT * FROM conversations WHERE session_id = ? AND tenant_id = ?").get(sessionId, tenantId);
  let state, messages;
  if (!convo) {
    state = { slots: generateSlots(), done: false };
    messages = [];
    db.prepare("INSERT INTO conversations (session_id, tenant_id, state, messages) VALUES (?, ?, ?, ?)").run(
  sessionId,
  tenantId,
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
    const cat = getCategoryForKey(db, tenantId, tc.category);
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
      const roster = getRoster(tenantId);
const load = getLoadByInstructor(tenantId);
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
    tenant_id, session_id, name, phone, email, dance_interest, goal_notes, lead_source,
    pipeline_stage, next_follow_up, assigned_instructor, recommended_product,
    potential_revenue, engagement, appointment_label, appointment_date, time_preference
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const info = insertLead.run(
  tenantId,
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
  "INSERT INTO sequences (tenant_id, lead_id, template_key, template_label) VALUES (?, ?, ?, ?)"
);
    const seqInfo = insertSeq.run(tenantId, leadId, templateKey, templateKeyLabel(templateKey));
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
router.get("/api/leads", async ({ req, res }) => {
  const rows = db.prepare("SELECT * FROM leads WHERE tenant_id = ? ORDER BY id DESC").all(req.tenantId);
  sendJson(res, 200, rows);
});

router.get("/api/leads.csv", async ({ req, res }) => {
  const rows = db.prepare("SELECT * FROM leads WHERE tenant_id = ? ORDER BY id ASC").all(req.tenantId);
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
router.get("/api/sequences", async ({ req, res }) => {
  const seqs = db.prepare("SELECT * FROM sequences WHERE tenant_id = ? ORDER BY id DESC").all(req.tenantId);
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

router.post("/api/sequences/simulate", async ({ req, res, body }) => {
  const { leadId, templateKey } = body;
  const leadRowRaw = db.prepare("SELECT * FROM leads WHERE id = ? AND tenant_id = ?").get(leadId, req.tenantId);
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
  "INSERT INTO sequences (tenant_id, lead_id, template_key, template_label) VALUES (?, ?, ?, ?)"
);
  const info = insertSeq.run(req.tenantId, leadId, templateKey, templateKeyLabel(templateKey));
  const insertStep = db.prepare(
    "INSERT INTO sequence_steps (sequence_id, send_date, send_date_sort, channel, body, status) VALUES (?,?,?,?,?,?)"
  );
  for (const s of steps) insertStep.run(info.lastInsertRowid, s.dateStr, s.sortKey, s.channel, s.body, s.status);

  sendJson(res, 200, { ok: true, sequenceId: info.lastInsertRowid });
});

// ============================================================
// Instructors / Studio Team
// ============================================================
router.get("/api/instructors", async ({ req, res }) => {
  sendJson(res, 200, getRoster(req.tenantId));
});

router.post("/api/instructors", async ({ req, res, body }) => {
  const { name, specialties } = body;
  if (!name || !name.trim()) return sendJson(res, 400, { error: "name is required" });
  try {
    db.prepare("INSERT INTO instructors (tenant_id, name, specialties, active) VALUES (?, ?, ?, 1)").run(
      req.tenantId,
      name.trim(),
      JSON.stringify(specialties || [])
    );
    sendJson(res, 201, { ok: true });
  } catch (e) {
    sendJson(res, 409, { error: "An instructor with that name already exists" });
  }
});

router.patch("/api/instructors/:id", async ({ req, res, params, body }) => {
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
  values.push(params.id, req.tenantId);
  try {
    db.prepare(`UPDATE instructors SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...values);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 409, { error: "An instructor with that name already exists" });
  }
});

router.delete("/api/instructors/:id", async ({ req, res, params }) => {
  db.prepare("DELETE FROM instructors WHERE id = ? AND tenant_id = ?").run(params.id, req.tenantId);
  sendJson(res, 200, { ok: true });
});

// ============================================================
// Pricing (admin-editable dance categories & rates)
// ============================================================
router.get("/api/pricing", async ({ req, res }) => {
  sendJson(res, 200, getCategories(db, req.tenantId));
});

router.post("/api/pricing", async ({ req, res, body }) => {
  try {
    const id = addCategory(db, req.tenantId, body || {});
    sendJson(res, 201, { ok: true, id });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

router.patch("/api/pricing/:id", async ({ req, res, params, body }) => {
  const updated = updateCategory(db, req.tenantId, params.id, body || {});
  if (!updated) return sendJson(res, 400, { error: "Nothing to update" });
  sendJson(res, 200, { ok: true });
});

router.delete("/api/pricing/:id", async ({ req, res, params }) => {
  deleteCategory(db, req.tenantId, params.id);
  sendJson(res, 200, { ok: true });
});

// ============================================================
// Signup — self-serve tenant creation. Public route (not admin-
// gated). Square billing isn't wired in yet — this creates the
// tenant and starts a 14-day trial; a follow-up piece will add
// actual Square customer/subscription creation alongside this.
// ============================================================
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/api/signup", async ({ res, body }) => {
  const studioName = (body.studioName || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = (body.password || "").toString();
  const tier = (body.tier || "").trim().toLowerCase();
  const cardToken = (body.cardToken || "").toString();

  if (!studioName) return sendJson(res, 400, { error: "Studio/business name is required" });
  if (!isValidEmail(email)) return sendJson(res, 400, { error: "A valid email is required" });
  if (password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters" });
  if (!cardToken) return sendJson(res, 400, { error: "Card details are required to start your trial" });

  const tierMap = { instructor: "solo", studio: "studio" };
  const accountType = tierMap[tier];
  if (!accountType) return sendJson(res, 400, { error: "Choose a plan: Dance Instructor or Studio Owner" });

  const existing = db.prepare("SELECT id FROM tenants WHERE admin_user = ?").get(email);
  if (existing) return sendJson(res, 409, { error: "An account with that email already exists" });

  let squareIds;
  try {
    squareIds = await createTrialSubscription({ studioName, email, cardToken, tier });
  } catch (err) {
    console.warn("Square signup failed:", err.message);
    return sendJson(res, 402, {
      error: "We couldn't verify your card. Please check your details and try again.",
    });
  }

  const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const info = db
    .prepare(
      `INSERT INTO tenants (name, admin_user, admin_password, account_type, subscription_status, trial_ends_at, square_customer_id, square_subscription_id)
       VALUES (?, ?, ?, ?, 'trialing', ?, ?, ?)`
    )
    .run(
      studioName,
      email,
      hashPassword(password),
      accountType,
      trialEndsAt,
      squareIds.squareCustomerId,
      squareIds.squareSubscriptionId
    );

  sendJson(res, 201, {
    ok: true,
    tenantId: info.lastInsertRowid,
    accountType,
    trialEndsAt,
  });
});

// ============================================================
// Forgot / reset password
// ============================================================
router.post("/api/forgot-password", async ({ req, res, body }) => {
  const email = (body.email || "").trim().toLowerCase();
  const genericMsg = "If an account exists for that email, we've sent a password reset link.";

  if (!isValidEmail(email)) {
    // Still generic — don't reveal whether the address is even
    // well-formed-but-unregistered vs malformed.
    return sendJson(res, 200, { ok: true, message: genericMsg });
  }

    const tenant = db.prepare("SELECT id, name FROM tenants WHERE admin_user = ?").get(email);
  if (tenant) {
    console.log(`Password reset requested for tenant ${tenant.id} (${email}) — tenant found, sending email.`);
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE tenants SET reset_token_hash = ?, reset_token_expires_at = ? WHERE id = ?").run(
      tokenHash,
      expiresAt,
      tenant.id
    );

    const resetUrl = `https://${req.headers.host}/reset-password.html?token=${token}`;
    try {
      await sendEmail({
        to: email,
        subject: `Reset your ${STUDIO_NAME} password`,
        body: `Hi ${tenant.name},\n\nWe received a request to reset your password. Click the link below to set a new one — this link expires in 1 hour:\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
      });
      console.log(`Password reset email sent successfully to ${email}.`);
    } catch (err) {
      console.warn(`Password reset email FAILED for ${email}:`, err.message);
      // Still return the generic success message — don't leak
      // whether the send failed, and don't block the response on it.
    }
  } else {
    console.log(`Password reset requested for ${email} — no matching tenant found, no email sent.`);
  }

  sendJson(res, 200, { ok: true, message: genericMsg });
});

router.post("/api/reset-password", async ({ res, body }) => {
  const token = (body.token || "").toString();
  const password = (body.password || "").toString();

  if (!token) return sendJson(res, 400, { error: "Missing reset token" });
  if (password.length < 8) return sendJson(res, 400, { error: "Password must be at least 8 characters" });

  const tokenHash = hashResetToken(token);
  const tenant = db
    .prepare("SELECT id, reset_token_expires_at FROM tenants WHERE reset_token_hash = ?")
    .get(tokenHash);

  if (!tenant || !tenant.reset_token_expires_at || new Date(tenant.reset_token_expires_at) < new Date()) {
    return sendJson(res, 400, { error: "This reset link is invalid or has expired." });
  }

  db.prepare("UPDATE tenants SET admin_password = ?, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = ?").run(
    hashPassword(password),
    tenant.id
  );

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
router.get("/api/me", async ({ req, res }) => {
  const tenant = db.prepare("SELECT id, name, account_type FROM tenants WHERE id = ?").get(req.tenantId);
  if (!tenant) return sendJson(res, 404, { error: "Tenant not found" });
  sendJson(res, 200, {
    studioName: tenant.name,
    accountType: tenant.account_type,
  });
});

router.get("/api/onboarding/status", async ({ req, res }) => {
  const tenant = db.prepare("SELECT onboarding_completed, chosen_offer_key FROM tenants WHERE id = ?").get(req.tenantId);
  if (!tenant) return sendJson(res, 404, { error: "Tenant not found" });
  sendJson(res, 200, {
    onboardingCompleted: !!tenant.onboarding_completed,
    chosenOfferKey: tenant.chosen_offer_key,
    offers: getOfferTemplates(),
  });
});

router.post("/api/onboarding/offer", async ({ req, res, body }) => {
  const key = (body.offerKey || "").trim();
  const offer = getOfferByKey(key);
  if (!offer) return sendJson(res, 400, { error: "Choose a valid offer" });

  db.prepare("UPDATE tenants SET chosen_offer_key = ? WHERE id = ?").run(key, req.tenantId);
  sendJson(res, 200, { ok: true, offer });
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


// ============================================================
// Square webhook — handled here directly (not via router) since
// signature verification needs the exact raw request bytes, and
// the router's JSON parser would consume/transform them first.
// ============================================================
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function verifySquareSignature(rawBody, signatureHeader, notificationUrl) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!key || !signatureHeader) return false;
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(notificationUrl + rawBody);
  const expected = hmac.digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handleSquareWebhook(req, res) {
  const rawBody = await readRawBody(req);
  const signature = req.headers["x-square-hmacsha256-signature"];
  const notificationUrl = `https://${req.headers.host}/api/webhooks/square`;

  if (!verifySquareSignature(rawBody, signature, notificationUrl)) {
    console.warn("Square webhook: signature verification failed");
    res.writeHead(401);
    return res.end();
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }

  try {
    const type = event.type;
    const data = event.data && event.data.object;

    if (type === "subscription.created" || type === "subscription.updated") {
      const sub = data && data.subscription;
      if (sub && sub.id) {
        let status = "trialing";
        if (sub.status === "ACTIVE") status = "active";
        else if (sub.status === "CANCELED") status = "canceled";
        else if (sub.status === "PAUSED") status = "paused";
        db.prepare("UPDATE tenants SET subscription_status = ? WHERE square_subscription_id = ?").run(
          status,
          sub.id
        );
      }
    } else if (type === "invoice.payment_made") {
      const invoice = data && data.invoice;
      if (invoice && invoice.subscription_id) {
        db.prepare("UPDATE tenants SET subscription_status = 'active' WHERE square_subscription_id = ?").run(
          invoice.subscription_id
        );
      }
    } else if (type === "invoice.scheduled_charge_failed") {
      const invoice = data && data.invoice;
      if (invoice && invoice.subscription_id) {
        db.prepare("UPDATE tenants SET subscription_status = 'past_due' WHERE square_subscription_id = ?").run(
          invoice.subscription_id
        );
      }
    }
  } catch (err) {
    console.warn("Square webhook handling error:", err.message);
  }

  res.writeHead(200);
  res.end();
}

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

  if (req.method === "POST" && pathname === "/api/webhooks/square") {
    return handleSquareWebhook(req, res);
  }

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
