// lib/normalize.js — input cleaning shared by every event route.

// Practical email check: one @, no spaces, a dot in the domain, sane lengths.
// Deliberately not RFC-complete; rejects the junk that matters
// ("test", "a@b", "name @gmail.com", "x@y.").
const EMAIL_RE = /^[^\s@"<>(),;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/**
 * Step 2 + 3 of the spec: validate, then trim + lowercase.
 * @returns {{ ok: true, email: string } | { ok: false, reason: string }}
 */
function normalizeEmail(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: false, reason: "Email is missing" };
  }
  const email = String(raw).trim().toLowerCase();
  if (email.length > 254) return { ok: false, reason: "Email is too long" };
  if (!EMAIL_RE.test(email)) {
    return { ok: false, reason: `Not a valid email address: "${String(raw).slice(0, 100)}"` };
  }
  const local = email.split("@")[0];
  if (local.length > 64) return { ok: false, reason: "Email is not valid (local part too long)" };
  return { ok: true, email };
}

/**
 * Mobile → E.164. 10-digit Indian numbers get the default country code.
 * Returns null when the input is empty or not a plausible number
 * (an unusable number is ignored, it never blocks the event).
 */
function normalizeMobile(raw, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || "91") {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const hasPlus = str.startsWith("+");
  let digits = str.replace(/\D/g, "");
  if (!digits) return null;
  if (!hasPlus) {
    if (digits.startsWith("00")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = defaultCountryCode + digits.slice(1);
    else if (digits.length === 10) digits = defaultCountryCode + digits;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  // Indian mobiles: +91 followed by 10 digits starting 6-9.
  if (digits.startsWith("91") && digits.length === 12 && !/^[6-9]/.test(digits.slice(2))) return null;
  return `+${digits}`;
}

function cleanText(value, maxLen = 255) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/** Page names are stored lowercase without slashes: "/love.html" → "love". */
function cleanPage(value) {
  const s = cleanText(value, 200);
  if (!s) return null;
  let page = s.toLowerCase();
  try {
    if (/^https?:\/\//.test(page)) page = new URL(page).pathname;
  } catch {
    /* keep as-is */
  }
  page = page.replace(/^\/+|\/+$/g, "").replace(/\.html?$/, "").replace(/^index$/, "");
  return (page || "home").slice(0, 100);
}

function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return false;
  return ["1", "true", "yes", "on", "y", "checked"].includes(String(value).trim().toLowerCase());
}

module.exports = { normalizeEmail, normalizeMobile, cleanText, cleanPage, parseBool };
