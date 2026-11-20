/**
 * services/netlifyParser.js — Netlify form-notification webhook → event shape.
 *
 * Netlify posts the submission as JSON: top-level id, form_name, created_at,
 * email, name, body and a `data` object holding every form field plus
 * ip / user_agent / referrer. We read from `data` first.
 * Field names accepted for the optional mobile: mobile, phone, phone_number, whatsapp.
 */

const { cleanText } = require("../lib/normalize");

const KNOWN = new Set([
  "email", "name", "first_name", "last_name", "mobile", "phone", "phone_number", "whatsapp",
  "message", "page", "first_page_seen", "utm_source", "utm_medium", "utm_campaign",
  "ip", "user_agent", "referrer", "form-name", "bot-field",
]);

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
  }
  return null;
}

function pageFromReferrer(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).pathname;
  } catch {
    return null;
  }
}

function utmFromReferrer(referrer, key) {
  if (!referrer) return null;
  try {
    return new URL(referrer).searchParams.get(key) || null;
  } catch {
    return null;
  }
}

function parseNetlify(body) {
  const b = body || {};
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const all = { ...b, ...data };
  const fullName = [all.first_name, all.last_name].filter(Boolean).join(" ");

  // Every other field the form has (e.g. "I'm interested in") is kept on the event.
  const otherFields = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN.has(k) && v !== null && v !== undefined && String(v).trim() !== "") {
      otherFields[k] = typeof v === "string" ? v.slice(0, 1000) : v;
    }
  }

  return {
    submissionId: cleanText(b.id, 100),
    formName: cleanText(b.form_name || data["form-name"], 100),
    email: pick(all, ["email"]),
    name: pick(data, ["name"]) || fullName || pick(b, ["name"]),
    mobile: pick(data, ["mobile", "phone", "phone_number", "whatsapp"]),
    message: pick(data, ["message"]) || b.body || null,
    page: pick(data, ["page", "first_page_seen"]) || pageFromReferrer(data.referrer) || "contact",
    // Hidden utm_* fields win; otherwise the tags on the page URL the form was sent from.
    utm: {
      source: data.utm_source || utmFromReferrer(data.referrer, "utm_source"),
      medium: data.utm_medium || utmFromReferrer(data.referrer, "utm_medium"),
      campaign: data.utm_campaign || utmFromReferrer(data.referrer, "utm_campaign"),
    },
    createdAt: b.created_at ? new Date(b.created_at) : null,
    otherFields,
  };
}

/**
 * Netlify SIGN-UP forms (e.g. "offer-signup") — same payload, read as a
 * sign-up: email, optional name/mobile, consent checkbox, page, UTM tags.
 * Consent field names accepted: consent, marketing_consent, email_consent,
 * opt_in / optin, subscribe, newsletter, agree. A ticked checkbox sends its
 * value (Netlify default "on"); unticked sends nothing → no consent.
 */
const CONSENT_FIELDS = ["consent", "marketing_consent", "email_consent", "opt_in", "optin", "opt-in", "subscribe", "newsletter", "agree"];

function consentValue(data) {
  for (const k of CONSENT_FIELDS) {
    if (data[k] === undefined || data[k] === null) continue;
    const v = Array.isArray(data[k]) ? data[k].join(",") : String(data[k]).trim().toLowerCase();
    if (!v || ["no", "false", "0", "off", "n"].includes(v)) return false;
    return true;
  }
  return false;
}

function parseNetlifySignup(body) {
  const base = parseNetlify(body);
  const data = body && typeof body.data === "object" ? body.data : {};
  const otherFields = { ...base.otherFields };
  for (const k of CONSENT_FIELDS) delete otherFields[k];
  return {
    ...base,
    page: pick(data, ["page", "first_page_seen"]) || pageFromReferrer(data.referrer) || base.formName || "signup",
    consent: consentValue(data),
    otherFields,
  };
}

module.exports = { parseNetlify, parseNetlifySignup };
