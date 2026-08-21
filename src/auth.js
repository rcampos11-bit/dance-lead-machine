// ============================================================
// Password hashing — node:crypto scrypt, zero external deps.
// Stored format: "scrypt$<saltHex>$<hashHex>" so we can tell
// hashed values apart from legacy plain-text ones already in
// the database (see the migration in db.js).
// ============================================================
const crypto = require("node:crypto");

const PREFIX = "scrypt";
const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, KEYLEN).toString("hex");
  return `${PREFIX}$${salt}$${hash}`;
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}$`);
}

function verifyPassword(password, stored) {
  if (!isHashed(stored)) {
    // Legacy plain-text row that somehow wasn't migrated yet —
    // fall back to a direct compare so nobody gets locked out.
    return String(password) === String(stored);
  }
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const [, salt, hashHex] = parts;
  const hash = Buffer.from(hashHex, "hex");
  const candidate = crypto.scryptSync(String(password), salt, KEYLEN);
  if (candidate.length !== hash.length) return false;
  return crypto.timingSafeEqual(candidate, hash);
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

module.exports = { hashPassword, verifyPassword, isHashed, hashResetToken };
