// ============================================================
// Pricing categories — admin-editable dance categories & rates.
// Every studio/instructor charges differently, so category
// pricing is no longer hardcoded in source. It lives in the
// `pricing_categories` table (see db.js) and is fully managed
// from the admin dashboard's Pricing tab / the /api/pricing
// routes in server.js. DEFAULT_CATEGORIES below is only ever
// used to seed a brand-new database on first run.
// ============================================================

const DEFAULT_CATEGORIES = [
  { key: "wedding", label: "Wedding Dance", product: "Wedding Package (Private Lessons)", revenue: 900 },
  { key: "competitive", label: "Competitive / Team", product: "Competitive Team Program", revenue: 1400 },
  { key: "kids", label: "Kids Program", product: "Kids Beginner Program", revenue: 300 },
  { key: "private", label: "Private Lessons", product: "Private Lesson Package", revenue: 750 },
  { key: "group", label: "Group Class", product: "Group Class Series", revenue: 240 },
  { key: "social", label: "Social Dancing", product: "Social/Practice Party Pass", revenue: 120 },
  { key: "workshop", label: "Workshop / Event", product: "Workshop Ticket", revenue: 150 },
  { key: "beginner", label: "Beginner / Never Danced", product: "Beginner Program", revenue: 320 },
];

function slugify(label) {
  const s = String(label || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "category";
}

function rowToCategory(r) {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    product: r.product,
    revenue: r.revenue,
    active: !!r.active,
    sortOrder: r.sort_order,
  };
}

// All categories (active + inactive), in display order.
function getCategories(db) {
  const rows = db.prepare("SELECT * FROM pricing_categories ORDER BY sort_order ASC, id ASC").all();
  return rows.map(rowToCategory);
}

function getActiveCategories(db) {
  return getCategories(db).filter((c) => c.active);
}

function getCategoryMap(db) {
  const map = {};
  for (const c of getCategories(db)) map[c.key] = c;
  return map;
}

// Looks up a category by key; falls back to any active category
// (e.g. if the AI or a stale client sends a key that no longer
// exists because it was renamed/removed) rather than throwing.
function getCategoryForKey(db, key) {
  const map = getCategoryMap(db);
  if (map[key]) return map[key];
  const active = getActiveCategories(db);
  return active[0] || null;
}

function keyTaken(db, key, ignoreId) {
  const row = db.prepare("SELECT id FROM pricing_categories WHERE key = ?").get(key);
  return !!row && row.id !== ignoreId;
}

function uniqueKey(db, desired, ignoreId) {
  const base = slugify(desired);
  let candidate = base;
  let n = 2;
  while (keyTaken(db, candidate, ignoreId)) {
    candidate = `${base}_${n++}`;
  }
  return candidate;
}

function addCategory(db, { key, label, product, revenue }) {
  const cleanLabel = (label || "").trim();
  if (!cleanLabel) throw new Error("label is required");
  const finalKey = uniqueKey(db, key || cleanLabel);
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM pricing_categories").get().m;
  const info = db
    .prepare(
      "INSERT INTO pricing_categories (key, label, product, revenue, active, sort_order) VALUES (?, ?, ?, ?, 1, ?)"
    )
    .run(finalKey, cleanLabel, (product || cleanLabel).trim(), Number(revenue) || 0, maxOrder + 1);
  return info.lastInsertRowid;
}

function updateCategory(db, id, fields) {
  const sets = [];
  const values = [];
  if (typeof fields.label === "string" && fields.label.trim()) {
    sets.push("label = ?");
    values.push(fields.label.trim());
  }
  if (typeof fields.product === "string" && fields.product.trim()) {
    sets.push("product = ?");
    values.push(fields.product.trim());
  }
  if (fields.revenue !== undefined && fields.revenue !== null && !Number.isNaN(Number(fields.revenue))) {
    sets.push("revenue = ?");
    values.push(Number(fields.revenue));
  }
  if (typeof fields.active === "boolean") {
    sets.push("active = ?");
    values.push(fields.active ? 1 : 0);
  }
  if (sets.length === 0) return false;
  values.push(id);
  db.prepare(`UPDATE pricing_categories SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return true;
}

function deleteCategory(db, id) {
  db.prepare("DELETE FROM pricing_categories WHERE id = ?").run(id);
}

module.exports = {
  DEFAULT_CATEGORIES,
  slugify,
  getCategories,
  getActiveCategories,
  getCategoryMap,
  getCategoryForKey,
  addCategory,
  updateCategory,
  deleteCategory,
};
