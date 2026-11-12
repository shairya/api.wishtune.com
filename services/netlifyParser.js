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
    utm: {
      source: data.utm_source || null,
      medium: data.utm_medium || null,
      campaign: data.utm_campaign || null,
    },
    createdAt: b.created_at ? new Date(b.created_at) : null,
    otherFields,
  };
}

module.exports = { parseNetlify };
