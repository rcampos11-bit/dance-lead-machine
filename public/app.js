/* ============================================================
   DANCE LEAD MACHINE — frontend for the REAL connected backend.
   Talks to /api/* — no business logic lives here anymore beyond
   rendering; the server (with real Claude + a real database) is
   the source of truth.
   ============================================================ */

const CATEGORY_LABELS = {
  wedding: "Wedding Dance",
  competitive: "Competitive / Team",
  kids: "Kids Program",
  private: "Private Lessons",
  group: "Group Class",
  social: "Social Dancing",
  workshop: "Workshop / Event",
  beginner: "Beginner / Never Danced",
};

const QUICKSTARTS = [
  { label: "Wedding lead", text: "My fiancé and I need help with our first dance for our wedding in October." },
  { label: "Beginner lead", text: "I've never danced before. Do you have beginner classes?" },
  { label: "Private lessons", text: "I'm looking for private lessons, ideally once a week." },
  { label: "Competitive team", text: "I used to compete years ago and want to get back into it and join a team." },
  { label: "Kids class", text: "Hi! Do you have classes for my daughter, she's 7?" },
  { label: "Unclear inquiry", text: "Hi, I saw your QR code at the coffee shop and got curious about dance lessons." },
];

const SEQUENCE_LIBRARY_DISPLAY = [
  { label: "Appointment Booked — Reminder Sequence", steps: "1d before (text) → day of (text)" },
  { label: "New Inquiry — No Response Yet", steps: "day of (email) → +1d (text) → +3d (email) → +7d (text)" },
  { label: "Missed Appointment — Win-Back", steps: "day of (text) → +1d (email) → +4d (text)" },
  { label: "Trial Completed — No Purchase Yet", steps: "+1d (text) → +3d (email) → +7d (text)" },
  { label: "Cold Lead — Monthly Nurture", steps: "day of (email) → +30d (email)" },
];

let sessionId = null;
let lastDone = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addMessage(text, cls) {
  const el = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function botSay(t) { addMessage(t, "bot"); }
function userSay(t) { addMessage(t, "user"); }

function addLeadCard(lead) {
  const el = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "lead-card";
  const contactParts = [];
  if (lead.phone) contactParts.push(escapeHtml(lead.phone));
  if (lead.email) contactParts.push(escapeHtml(lead.email));
  const contactRow = `<tr><td class="k">Contact</td><td>${contactParts.join(" · ") || "—"}</td></tr>`;
  const stageRow = `<tr><td class="k">Status</td><td>Qualified — ${escapeHtml(lead.assignedInstructor)} to schedule personally</td></tr>`;
const prefRow = lead.timePreference
  ? `<tr><td class="k">Best Time</td><td>${escapeHtml(lead.timePreference.charAt(0).toUpperCase() + lead.timePreference.slice(1))}</td></tr>`
  : `<tr><td class="k">Best Time</td><td>No preference given</td></tr>`;
  div.innerHTML = `
    <h4>✅ Lead captured — saved to the database</h4>
    <table>
      <tr><td class="k">Name</td><td>${escapeHtml(lead.name)}</td></tr>
      ${contactRow}
      <tr><td class="k">Interest</td><td>${escapeHtml(lead.danceInterest)}</td></tr>
      <tr><td class="k">Recommended</td><td>${escapeHtml(lead.recommendedProduct)}</td></tr>
      <tr><td class="k">Potential Revenue</td><td>$${Number(lead.potentialRevenue).toLocaleString()}</td></tr>
      ${stageRow}
${prefRow}
    </table>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function newConversation() {
  sessionId = null;
  lastDone = false;
  document.getElementById("messages").innerHTML = "";
  botSay("Hi there! 👋 Thanks for reaching out to Dance Lead Machine™ Studio. I'm here to help — what brings you in today?");
}

async function sendMessage(text) {
  userSay(text);
  const sendBtn = document.getElementById("sendBtn");
  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      botSay("⚠️ " + (data.error || "Something went wrong talking to the AI. Check the server has ANTHROPIC_API_KEY set."));
      return;
    }
    sessionId = data.sessionId;
    lastDone = !!data.done;
    botSay(data.reply);
    if (data.done && data.lead) {
      addLeadCard(data.lead);
      await Promise.all([refreshLeads(), refreshSequences(), refreshRoster()]);
    }
  } catch (err) {
    botSay("⚠️ Couldn't reach the server. Is it running?");
  } finally {
    sendBtn.disabled = false;
  }
}

document.getElementById("sendBtn").addEventListener("click", () => {
  const input = document.getElementById("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  if (lastDone) {
    newConversation();
    setTimeout(() => sendMessage(text), 400);
  } else {
    sendMessage(text);
  }
});
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sendBtn").click();
});
document.getElementById("resetBtn").addEventListener("click", newConversation);

const qsEl = document.getElementById("quickstart");
QUICKSTARTS.forEach((q) => {
  const btn = document.createElement("button");
  btn.className = "qs-btn";
  btn.textContent = q.label;
  btn.addEventListener("click", () => {
    document.getElementById("input").value = q.text;
    document.getElementById("sendBtn").click();
  });
  qsEl.appendChild(btn);
});

document.getElementById("exportAllBtn").addEventListener("click", () => {
  window.location.href = "/api/leads.csv";
});

// ============================================================
// Captured Leads sidebar
// ============================================================
let allLeads = [];

async function refreshLeads() {
  const res = await fetch("/api/leads");
  allLeads = await res.json();
  document.getElementById("leadCount").textContent = allLeads.length;
  const el = document.getElementById("leadList");
  if (allLeads.length === 0) {
    el.innerHTML = '<div class="empty">No leads captured yet — finish a conversation to see one appear here.</div>';
    return;
  }
  el.innerHTML = "";
  allLeads.forEach((lead) => {
  const row = document.createElement("div");
  row.className = "lead-row";
  const tagColor = lead.pipeline_stage === "Appointment Booked" ? "var(--hot)" : "var(--warm)";
  const stageLine = lead.appointment_label
    ? `📅 ${escapeHtml(lead.appointment_label)} · ${escapeHtml(lead.assigned_instructor || "")}`
    : `⏳ ${escapeHtml(lead.pipeline_stage)} · ${escapeHtml(lead.assigned_instructor || "")}`;
  const prefLine = lead.time_preference
    ? `<div class="meta">🕐 Best time: ${escapeHtml(lead.time_preference.charAt(0).toUpperCase() + lead.time_preference.slice(1))}</div>`
    : "";
  row.innerHTML = `
    <div><span class="name">${escapeHtml(lead.name || "(no name)")}</span>
      <span class="tag" style="background:${tagColor}">${escapeHtml(lead.dance_interest || "")}</span>
    </div>
    <div class="meta">${escapeHtml(lead.recommended_product || "")} · $${Number(lead.potential_revenue || 0).toLocaleString()} · Engagement ${lead.engagement}/5</div>
    <div class="meta">${stageLine}</div>
    ${prefLine}`;
  el.appendChild(row);
});
}

// ============================================================
// Follow-Up Center
// ============================================================
function renderSequenceLibrary() {
  const el = document.getElementById("seqLibrary");
  el.innerHTML = "";
  SEQUENCE_LIBRARY_DISPLAY.forEach((tmpl) => {
    const div = document.createElement("div");
    div.className = "seq-lib-item";
    div.innerHTML = `<div class="name">${escapeHtml(tmpl.label)}</div><div class="steps">${escapeHtml(tmpl.steps)}</div>`;
    el.appendChild(div);
  });
}

async function populateSimLeadSelect() {
  const sel = document.getElementById("simLeadSelect");
  const prevVal = sel.value;
  sel.innerHTML = "";
  if (allLeads.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No leads captured yet";
    opt.value = "";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  allLeads.forEach((lead) => {
    const opt = document.createElement("option");
    opt.value = lead.id;
    opt.textContent = `${lead.name} — ${lead.dance_interest}`;
    sel.appendChild(opt);
  });
  if (prevVal) sel.value = prevVal;
}

let allSequences = [];

async function refreshSequences() {
  const res = await fetch("/api/sequences");
  allSequences = await res.json();
  document.getElementById("fuCount").textContent = allSequences.reduce((n, s) => n + s.steps.length, 0);

  const el = document.getElementById("timelineList");
  if (allSequences.length === 0) {
    el.innerHTML = '<div class="empty">No follow-up sequences yet — finish a chat or simulate an event to see one appear here.</div>';
  } else {
    el.innerHTML = "";
    allSequences.forEach((seq) => {
      const card = document.createElement("div");
      card.className = "lead-timeline-card";
      const stepsHtml = seq.steps.map((s) => `
        <div class="timeline-item ${s.status}">
          <div class="ti-row">
            <span class="ti-date">${escapeHtml(s.send_date)}</span>
            <span class="channel-badge ${s.channel}">${s.channel === "email" ? "✉ EMAIL" : "💬 TEXT"}</span>
            <span class="status-pill ${s.status}">${s.status === "sent" ? "SENT" : "SCHEDULED"}</span>
          </div>
          <div class="ti-msg">${escapeHtml(s.body)}</div>
        </div>`).join("");
      card.innerHTML = `
        <div class="lt-head">
          <span class="name">${escapeHtml(seq.leadName)}</span>
          <span class="trigger">${escapeHtml(seq.templateLabel)}</span>
        </div>
        <div class="timeline">${stepsHtml}</div>`;
      el.appendChild(card);
    });
  }

  const allSends = allSequences
    .flatMap((seq) => seq.steps.map((s) => ({ ...s, leadName: seq.leadName, trigger: seq.templateLabel })))
    .sort((a, b) => (a.send_date_sort || "").localeCompare(b.send_date_sort || ""));
  document.getElementById("sendCount").textContent = allSends.length;
  const body = document.getElementById("sendTableBody");
  body.innerHTML = "";
  allSends.forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.leadName)}</td>
      <td>${escapeHtml(s.send_date)}</td>
      <td><span class="channel-badge ${s.channel}">${s.channel === "email" ? "EMAIL" : "TEXT"}</span></td>
      <td><span class="status-pill ${s.status}">${s.status === "sent" ? "SENT" : "SCHEDULED"}</span></td>
      <td>${escapeHtml(s.body)}</td>`;
    body.appendChild(tr);
  });

  await populateSimLeadSelect();
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

document.getElementById("exportSendsBtn").addEventListener("click", () => {
  const allSends = allSequences
    .flatMap((seq) => seq.steps.map((s) => ({ ...s, leadName: seq.leadName, trigger: seq.templateLabel })))
    .sort((a, b) => (a.send_date_sort || "").localeCompare(b.send_date_sort || ""));
  if (allSends.length === 0) {
    showToast("No follow-up sequences yet.");
    return;
  }
  const headers = ["Lead Name", "Trigger", "Send Date", "Channel", "Status", "Message"];
  const rows = allSends.map((s) => [s.leadName, s.trigger, s.send_date, s.channel, s.status, s.body]);
  const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ai_followup_scheduled_sends.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

document.getElementById("simAddBtn").addEventListener("click", async () => {
  const leadId = parseInt(document.getElementById("simLeadSelect").value);
  const templateKey = document.getElementById("simTriggerSelect").value;
  if (!leadId) {
    showToast("Pick a lead first — or finish a chat conversation to create one.");
    return;
  }
  const res = await fetch("/api/sequences/simulate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leadId, templateKey }),
  });
  if (res.ok) {
    await refreshSequences();
    showToast("Follow-up sequence added.");
  } else {
    showToast("Couldn't add sequence.");
  }
});

// ============================================================
// Studio Team
// ============================================================
function populateSpecialtyChecks() {
  const el = document.getElementById("specialtyChecks");
  el.innerHTML = "";
  Object.entries(CATEGORY_LABELS).forEach(([key, label]) => {
    const lbl = document.createElement("label");
    lbl.innerHTML = `<input type="checkbox" id="spec_${key}" value="${key}"> ${escapeHtml(label)}`;
    el.appendChild(lbl);
  });
}

let roster = [];
let editingInstructorId = null;

function renderInstructorCard(inst, instLeads, booked, revenue) {
  const card = document.createElement("div");
  card.className = "instructor-card" + (inst.active ? "" : " inactive");

  if (editingInstructorId === inst.id) {
    const specChecksHtml = Object.entries(CATEGORY_LABELS)
      .map(([key, label]) => {
        const checked = inst.specialties.includes(key) ? "checked" : "";
        return `<label><input type="checkbox" class="edit-spec" value="${key}" ${checked}> ${escapeHtml(label)}</label>`;
      })
      .join("");
    card.innerHTML = `
      <div class="ic-head">
        <span class="ic-name">Editing: ${escapeHtml(inst.name)}</span>
      </div>
      <div class="add-instructor-form" style="margin:0;">
        <input type="text" class="edit-name" value="${escapeHtml(inst.name)}" placeholder="Instructor name">
        <div class="specialty-checks">${specChecksHtml}</div>
      </div>
      <div class="ic-actions">
        <button data-action="save" data-id="${inst.id}">Save</button>
        <button data-action="cancel" data-id="${inst.id}" class="danger">Cancel</button>
      </div>`;
    return card;
  }

  const specLabels = inst.specialties.length
    ? inst.specialties.map((k) => CATEGORY_LABELS[k] || k).join(", ")
    : "No specialty — general rotation";
  card.innerHTML = `
    <div class="ic-head">
      <span class="ic-name">${escapeHtml(inst.name)}</span>
      <span class="channel-badge" style="background:${inst.active ? "var(--navy-light)" : "#999"}">${inst.active ? "ACTIVE" : "INACTIVE"}</span>
    </div>
    <div class="ic-specialty">${escapeHtml(specLabels)}</div>
    <div class="ic-stats">
      <div class="stat"><div class="num">${instLeads.length}</div><div class="lbl">Leads</div></div>
      <div class="stat"><div class="num">${booked}</div><div class="lbl">Booked</div></div>
      <div class="stat"><div class="num">$${revenue.toLocaleString()}</div><div class="lbl">Potential</div></div>
    </div>
    <div class="ic-actions">
      <button data-action="edit" data-id="${inst.id}">Edit</button>
      <button data-action="toggle" data-id="${inst.id}">${inst.active ? "Set Inactive" : "Set Active"}</button>
      <button data-action="remove" data-id="${inst.id}" class="danger">Remove</button>
    </div>`;
  return card;
}
function renderSoloStats() {
  document.getElementById("teamCount").textContent = allLeads.length ? 1 : 0;
  document.getElementById("teamRosterCount").textContent = allLeads.length ? 1 : 0;

  const totalRevenue = allLeads.reduce((sum, l) => sum + Number(l.potential_revenue || 0), 0);
  const byCategory = {};
  allLeads.forEach((l) => {
    const key = l.dance_interest || "Uncategorized";
    if (!byCategory[key]) byCategory[key] = { count: 0, revenue: 0 };
    byCategory[key].count += 1;
    byCategory[key].revenue += Number(l.potential_revenue || 0);
  });

  const el = document.getElementById("rosterList");
  el.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "instructor-card";
  const rows = Object.entries(byCategory)
    .sort((a, b) => b[1].count - a[1].count)
    .map(
      ([label, v]) =>
        `<div class="ic-stats" style="justify-content:space-between;">
          <span>${escapeHtml(label)}</span>
          <span>${v.count} lead${v.count === 1 ? "" : "s"} · $${v.revenue.toLocaleString()}</span>
        </div>`
    )
    .join("");
  summary.innerHTML = `
    <div class="ic-head">
      <span class="ic-name">Your Leads</span>
    </div>
    <div class="ic-stats">
      <div class="stat"><div class="num">${allLeads.length}</div><div class="lbl">Total Leads</div></div>
      <div class="stat"><div class="num">$${totalRevenue.toLocaleString()}</div><div class="lbl">Potential</div></div>
    </div>
    ${rows || '<div class="empty">No leads yet.</div>'}`;
  el.appendChild(summary);
}

async function refreshRoster() {
  if (isSoloMode) {
    renderSoloStats();
    return;
  }
  
   const res = await fetch("/api/instructors");
  roster = await res.json();
  document.getElementById("teamCount").textContent = roster.filter((i) => i.active).length;
  document.getElementById("teamRosterCount").textContent = roster.length;

  const el = document.getElementById("rosterList");
  el.innerHTML = "";
  roster.forEach((inst) => {
    const instLeads = allLeads.filter((l) => l.assigned_instructor === inst.name);
    const booked = instLeads.filter((l) => l.pipeline_stage === "Appointment Booked").length;
    const revenue = instLeads.reduce((sum, l) => sum + Number(l.potential_revenue || 0), 0);
    el.appendChild(renderInstructorCard(inst, instLeads, booked, revenue));
  });

  const unassignedLeads = allLeads.filter((l) => !roster.some((i) => i.name === l.assigned_instructor && i.active));
  if (unassignedLeads.length > 0) {
    const note = document.createElement("div");
    note.className = "unassigned-note";
    note.textContent = `${unassignedLeads.length} lead(s) have no active matching instructor.`;
    el.appendChild(note);
  }

  el.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;

      if (action === "edit") {
        editingInstructorId = Number(id);
        await refreshRoster();
        return;
      }

      if (action === "cancel") {
        editingInstructorId = null;
        await refreshRoster();
        return;
      }

      if (action === "save") {
        const card = btn.closest(".instructor-card");
        const name = card.querySelector(".edit-name").value.trim();
        const specialties = Array.from(card.querySelectorAll(".edit-spec:checked")).map((cb) => cb.value);
        if (!name) {
          showToast("Name can't be empty.");
          return;
        }
        const res = await fetch(`/api/instructors/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, specialties }),
        });
        if (res.ok) {
          editingInstructorId = null;
          await refreshRoster();
          showToast("Instructor updated.");
        } else {
          const data = await res.json();
          showToast(data.error || "Couldn't save changes.");
        }
        return;
      }

      if (action === "toggle") {
        const inst = roster.find((i) => String(i.id) === String(id));
        await fetch(`/api/instructors/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ active: !inst.active }),
        });
        await refreshRoster();
        return;
      }

      if (action === "remove") {
        await fetch(`/api/instructors/${id}`, { method: "DELETE" });
        await refreshRoster();
      }
    });
  });
}

document.getElementById("addInstructorBtn").addEventListener("click", async () => {
  const nameInput = document.getElementById("newInstructorName");
  const name = nameInput.value.trim();
  if (!name) {
    showToast("Enter a name first.");
    return;
  }
  const specialties = Object.keys(CATEGORY_LABELS).filter((key) => document.getElementById("spec_" + key).checked);
  const res = await fetch("/api/instructors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, specialties }),
  });
  if (res.ok) {
    nameInput.value = "";
    document.querySelectorAll("#specialtyChecks input").forEach((cb) => (cb.checked = false));
    await refreshRoster();
    showToast(`${name} added to the studio team.`);
  } else {
    const data = await res.json();
    showToast(data.error || "Couldn't add instructor.");
  }
});

// ============================================================
// Pricing (admin-editable dance categories & rates)
// ============================================================
let pricingCategories = [];
let editingPricingId = null;

function renderPricingCard(cat) {
  const card = document.createElement("div");
  card.className = "instructor-card" + (cat.active ? "" : " inactive");

  if (editingPricingId === cat.id) {
    card.innerHTML = `
      <div class="ic-head">
        <span class="ic-name">Editing: ${escapeHtml(cat.label)}</span>
      </div>
      <div class="add-instructor-form" style="margin:0;">
        <input type="text" class="edit-label" value="${escapeHtml(cat.label)}" placeholder="Category label">
        <input type="text" class="edit-product" value="${escapeHtml(cat.product)}" placeholder="Product name">
        <input type="number" class="edit-revenue" value="${Number(cat.revenue || 0)}" placeholder="Typical revenue" min="0" step="1">
      </div>
      <div class="ic-actions">
        <button data-action="save" data-id="${cat.id}">Save</button>
        <button data-action="cancel" data-id="${cat.id}" class="danger">Cancel</button>
      </div>`;
    return card;
  }

  card.innerHTML = `
    <div class="ic-head">
      <span class="ic-name">${escapeHtml(cat.label)}</span>
      <span class="channel-badge" style="background:${cat.active ? "var(--navy-light)" : "#999"}">${cat.active ? "ACTIVE" : "INACTIVE"}</span>
    </div>
    <div class="ic-specialty">${escapeHtml(cat.product)}</div>
    <div class="ic-stats">
      <div class="stat"><div class="num">$${Number(cat.revenue || 0).toLocaleString()}</div><div class="lbl">Revenue</div></div>
      <div class="stat"><div class="num">${escapeHtml(cat.key)}</div><div class="lbl">Key</div></div>
    </div>
        <div class="ic-actions">
      <button data-action="edit" data-id="${cat.id}">Edit</button>
      <button data-action="toggle" data-id="${cat.id}">${cat.active ? "Set Inactive" : "Set Active"}</button>
      <button data-action="moveUp" data-id="${cat.id}">↑ Move Up</button>
      <button data-action="moveDown" data-id="${cat.id}">↓ Move Down</button>
      <button data-action="remove" data-id="${cat.id}" class="danger">Remove</button>
    </div>`;
  return card;
}

async function refreshPricing() {
  const res = await fetch("/api/pricing");
  pricingCategories = await res.json();
  const activeCount = pricingCategories.filter((c) => c.active).length;
  document.getElementById("pricingCount").textContent = activeCount;
  document.getElementById("pricingListCount").textContent = pricingCategories.length;

  const el = document.getElementById("pricingList");
  el.innerHTML = "";

  if (pricingCategories.length === 0) {
    el.innerHTML = '<div class="empty">No pricing categories yet — add one to the left.</div>';
    return;
  }

  pricingCategories.forEach((cat) => {
    el.appendChild(renderPricingCard(cat));
  });

  el.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;

      if (action === "edit") {
        editingPricingId = Number(id);
        await refreshPricing();
        return;
      }

      if (action === "cancel") {
        editingPricingId = null;
        await refreshPricing();
        return;
      }

      if (action === "save") {
        const card = btn.closest(".instructor-card");
        const label = card.querySelector(".edit-label").value.trim();
        const product = card.querySelector(".edit-product").value.trim();
        const revenue = card.querySelector(".edit-revenue").value;
        if (!label) {
          showToast("Label can't be empty.");
          return;
        }
        const res = await fetch(`/api/pricing/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label, product, revenue: Number(revenue) || 0 }),
        });
        if (res.ok) {
          editingPricingId = null;
          await refreshPricing();
          showToast("Category updated.");
        } else {
          const data = await res.json();
          showToast(data.error || "Couldn't save changes.");
        }
        return;
      }

      if (action === "toggle") {
        const cat = pricingCategories.find((c) => String(c.id) === String(id));
        await fetch(`/api/pricing/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ active: !cat.active }),
        });
        await refreshPricing();
        return;
      }
       
      if (action === "moveUp" || action === "moveDown") {
        const idx = pricingCategories.findIndex((c) => String(c.id) === String(id));
        const swapIdx = action === "moveUp" ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= pricingCategories.length) return;

        const current = pricingCategories[idx];
        const swapWith = pricingCategories[swapIdx];

        await Promise.all([
          fetch(`/api/pricing/${current.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sortOrder: swapWith.sortOrder }),
          }),
          fetch(`/api/pricing/${swapWith.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sortOrder: current.sortOrder }),
          }),
        ]);
        await refreshPricing();
        return;
      }
      if (action === "remove") {
        await fetch(`/api/pricing/${id}`, { method: "DELETE" });
        await refreshPricing();
      }
    });
  });
}

document.getElementById("addPricingBtn").addEventListener("click", async () => {
  const labelInput = document.getElementById("newPricingLabel");
  const productInput = document.getElementById("newPricingProduct");
  const revenueInput = document.getElementById("newPricingRevenue");
  const label = labelInput.value.trim();
  const product = productInput.value.trim();
  const revenue = revenueInput.value;
  if (!label) {
    showToast("Enter a category label first.");
    return;
  }
  const res = await fetch("/api/pricing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, product, revenue }),
  });
  if (res.ok) {
    labelInput.value = "";
    productInput.value = "";
    revenueInput.value = "";
    await refreshPricing();
    showToast(`${label} added to pricing.`);
  } else {
    const data = await res.json();
    showToast(data.error || "Couldn't add category.");
  }
});

// ============================================================
// Tabs + toast + health check
// ============================================================
function switchTab(which) {
  document.getElementById("view-receptionist").classList.toggle("view-hidden", which !== "receptionist");
  document.getElementById("view-followup").classList.toggle("view-hidden", which !== "followup");
  document.getElementById("view-team").classList.toggle("view-hidden", which !== "team");
  document.getElementById("view-pricing").classList.toggle("view-hidden", which !== "pricing");
  document.getElementById("tabBtnReceptionist").classList.toggle("active", which === "receptionist");
  document.getElementById("tabBtnFollowup").classList.toggle("active", which === "followup");
  document.getElementById("tabBtnTeam").classList.toggle("active", which === "team");
  document.getElementById("tabBtnPricing").classList.toggle("active", which === "pricing");
}
document.getElementById("tabBtnReceptionist").addEventListener("click", () => switchTab("receptionist"));
document.getElementById("tabBtnFollowup").addEventListener("click", () => switchTab("followup"));
document.getElementById("tabBtnTeam").addEventListener("click", () => switchTab("team"));
document.getElementById("tabBtnPricing").addEventListener("click", () => switchTab("pricing"));

function showToast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

async function checkHealth() {
  const badge = document.getElementById("liveBadge");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.hasApiKey) {
      badge.textContent = "● LIVE";
      badge.style.background = "#2E7D32";
    } else {
      badge.textContent = "⚠ NO API KEY SET";
      badge.style.background = "#B00020";
    }
  } catch {
    badge.textContent = "⚠ SERVER UNREACHABLE";
    badge.style.background = "#B00020";
  }
}

// ---- account type / solo mode ----
let isSoloMode = false;

async function applyAccountType() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return;
    const data = await res.json();
    if (data.accountType === "solo") {
                  isSoloMode = true;
      const firstName = (data.studioName || "My").split(" ")[0];
      document.getElementById("tabBtnTeam").innerHTML = `👤 ${escapeHtml(firstName)}'s Stats <span class="count-pill" id="teamCount">0</span>`;
      const leftCol = document.getElementById("teamLeftCol");
      if (leftCol) leftCol.style.display = "none";
      const heading = document.getElementById("teamHeading");
      if (heading) heading.innerHTML = `${escapeHtml(firstName)}'s Stats <span class="count-pill" id="teamRosterCount">0</span>`;
    }
  } catch {
    // if this fails, just leave Studio Team visible — fail open, not closed
  }
}

// ---- onboarding redirect check ----
async function checkOnboarding() {
  try {
    const res = await fetch("/api/onboarding/status");
    if (!res.ok) return true; // fail open — don't block the dashboard on a broken check
    const data = await res.json();
    if (!data.onboardingCompleted) {
      window.location.href = "/onboarding.html";
      return false;
    }
  } catch {
    // fail open — if the check itself fails, don't lock the user out
  }
  return true;
}

// ---- init ----
(async () => {
  const shouldContinue = await checkOnboarding();
  if (!shouldContinue) return;

  newConversation();
  renderSequenceLibrary();
  populateSpecialtyChecks();
  checkHealth();
  refreshPricing();

  await applyAccountType();
  await refreshLeads();
  await Promise.all([refreshSequences(), refreshRoster()]);
})();
