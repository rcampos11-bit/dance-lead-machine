// ============================================================
// Deterministic business logic — dance categories, appointment
// slots, instructor assignment, follow-up sequence templates.
// Ported from the client-side prototype. Nothing here calls AI;
// this is the reliable, testable "business rules" layer.
// ============================================================

const CATEGORIES = {
  wedding: {
    label: "Wedding Dance",
    product: "Wedding Package (Private Lessons)",
    revenue: 900,
  },
  competitive: {
    label: "Competitive / Team",
    product: "Competitive Team Program",
    revenue: 1400,
  },
  kids: {
    label: "Kids Program",
    product: "Kids Beginner Program",
    revenue: 300,
  },
  private: {
    label: "Private Lessons",
    product: "Private Lesson Package",
    revenue: 750,
  },
  group: {
    label: "Group Class",
    product: "Group Class Series",
    revenue: 240,
  },
  social: {
    label: "Social Dancing",
    product: "Social/Practice Party Pass",
    revenue: 120,
  },
  workshop: {
    label: "Workshop / Event",
    product: "Workshop Ticket",
    revenue: 150,
  },
  beginner: {
    label: "Beginner / Never Danced",
    product: "Beginner Program",
    revenue: 320,
  },
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Three realistic upcoming slots, skipping today.
function generateSlots(now = new Date()) {
  const offsets = [1, 1, 2];
  const times = ["10:00 AM", "3:30 PM", "5:00 PM"];
  return offsets.map((off, i) => {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() + off);
    const dayLabel = off === 1 ? "Tomorrow" : DAY_NAMES[d.getDay()];
    return {
      id: i + 1,
      label: `${dayLabel} at ${times[i]}`,
      dateStr: fmtDate(d),
      dateObj: d,
    };
  });
}

// Pick the least-busy active instructor matching the category's specialty,
// falling back to least-busy overall. `loadByInstructor` is {name: count}.
function pickInstructor(categoryKey, roster, loadByInstructor) {
  const active = roster.filter((i) => i.active);
  if (active.length === 0) return "Unassigned";
  const specialists = active.filter((i) => (i.specialties || []).includes(categoryKey));
  const pool = specialists.length ? specialists : active;
  let best = pool[0];
  let bestLoad = loadByInstructor[best.name] || 0;
  for (const inst of pool.slice(1)) {
    const load = loadByInstructor[inst.name] || 0;
    if (load < bestLoad) {
      best = inst;
      bestLoad = load;
    }
  }
  return best.name;
}

// ---- Follow-up sequence templates ----
const SEQUENCE_TEMPLATES = {
  appointment_reminder: {
    label: "Appointment Booked — Reminder Sequence",
    anchor: "appointment",
    steps: [
      { offsetDays: -1, channel: "text", body: "Hi {firstName}! Quick reminder — your {product} session with {instructor} is tomorrow ({apptLabel}). See you then!" },
      { offsetDays: 0, channel: "text", body: "Today's the day, {firstName}! Your session with {instructor} is at {apptTime}. Can't wait to dance with you!" },
    ],
  },
  new_inquiry_no_response: {
    label: "New Inquiry — No Response Yet",
    anchor: "today",
    steps: [
      { offsetDays: 0, channel: "email", body: "Hi {firstName}, thanks so much for reaching out about {product}! We'd love to get you scheduled — just reply here or call us anytime that works for you." },
      { offsetDays: 1, channel: "text", body: "Hi {firstName}, just checking in! Still happy to help you get started with {product} whenever you're ready." },
      { offsetDays: 3, channel: "email", body: "Hi {firstName} — still interested in {product}? We've got a few spots opening up this week and would love to have you in." },
      { offsetDays: 7, channel: "text", body: "Hi {firstName}, last check-in from us! Whenever the timing's right for {product}, we're here." },
    ],
  },
  missed_appointment: {
    label: "Missed Appointment — Win-Back",
    anchor: "today",
    steps: [
      { offsetDays: 0, channel: "text", body: "Hi {firstName}, we missed you today! No worries at all — want to grab a new time for {product}?" },
      { offsetDays: 1, channel: "email", body: "Hi {firstName}, life happens! Whenever you're ready to reschedule your {product} session with {instructor}, just let us know." },
      { offsetDays: 4, channel: "text", body: "Hi {firstName} — we'd still love to see you! Here's a little something extra to get you back on the floor: 10% off {product} this week only." },
    ],
  },
  trial_no_purchase: {
    label: "Trial Completed — No Purchase Yet",
    anchor: "today",
    steps: [
      { offsetDays: 1, channel: "text", body: "Hi {firstName}, it was great having you in for your trial! How did it feel? Would love to hear your thoughts." },
      { offsetDays: 3, channel: "email", body: "Hi {firstName}, ready to keep the momentum going with {product}? We can lock in your spot with {instructor} whenever you are." },
      { offsetDays: 7, channel: "text", body: "Hi {firstName}, just a friendly last note — your trial pricing on {product} is still available this week if you'd like to jump in!" },
    ],
  },
  cold_nurture: {
    label: "Cold Lead — Monthly Nurture",
    anchor: "today",
    steps: [
      { offsetDays: 0, channel: "email", body: "Hi {firstName}, it's been a bit! Just wanted to check in — {product} is still here whenever you're ready to give it a try." },
      { offsetDays: 30, channel: "email", body: "Hi {firstName}, hope you've been well! We've got some exciting things happening at the studio — would love to have you back in for {product}." },
    ],
  },
};

function firstNameOf(name) {
  return (name || "there").split(" ")[0];
}

function fillTemplate(body, lead) {
  const apptTime = lead.appointment ? (lead.appointment.split(" at ")[1] || lead.appointment) : "";
  return body
    .replaceAll("{firstName}", firstNameOf(lead.name))
    .replaceAll("{name}", lead.name || "there")
    .replaceAll("{product}", lead.recommendedProduct || "your lessons")
    .replaceAll("{instructor}", lead.assignedInstructor || "your instructor")
    .replaceAll("{apptLabel}", lead.appointment || "")
    .replaceAll("{apptTime}", apptTime);
}

function addDays(base, n) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

// Generates the list of scheduled-send rows for a lead + template.
// `apptDateObj` is required when the template anchors on the appointment.
function generateSequenceSteps(lead, templateKey, apptDateObj, now = new Date()) {
  const tmpl = SEQUENCE_TEMPLATES[templateKey];
  if (!tmpl) return [];
  const anchor = tmpl.anchor === "appointment" && apptDateObj ? apptDateObj : now;
  const today = new Date(now.getTime());
  today.setHours(0, 0, 0, 0);

  return tmpl.steps
    .map((s) => {
      const date = addDays(anchor, s.offsetDays);
      date.setHours(0, 0, 0, 0);
      return {
        date,
        dateStr: fmtDate(date),
        sortKey: date.toISOString().slice(0, 10),
        channel: s.channel,
        body: fillTemplate(s.body, lead),
        status: date <= today ? "sent" : "scheduled",
      };
    })
    .sort((a, b) => a.date - b.date);
}

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  generateSlots,
  pickInstructor,
  SEQUENCE_TEMPLATES,
  generateSequenceSteps,
  firstNameOf,
  fmtDate,
};
