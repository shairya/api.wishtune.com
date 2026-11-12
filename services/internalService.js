/**
 * services/internalService.js — team / test contacts.
 *
 * Settings → Test contacts holds three lists: emails, email domains and
 * coupon codes. A contact matching any of them is flagged is_internal with
 * internal_reason = 'rule'. Admins can also flag/unflag a contact by hand
 * (internal_reason = 'manual'); rules never override a manual choice.
 *
 * Internal contacts are kept out of dashboards, Meta exports and bots,
 * and hidden from the contact list unless asked for.
 */

const db = require("../config/mysql");
const { getSetting, setSetting } = require("./settingsService");

function cleanList(list, fn) {
  return [...new Set((Array.isArray(list) ? list : []).map(fn).filter(Boolean))].sort();
}

function normalizeRules(r = {}) {
  return {
    emails: cleanList(r.emails, (e) => String(e || "").trim().toLowerCase()).filter((e) => e.includes("@")),
    domains: cleanList(r.domains, (d) => String(d || "").trim().toLowerCase().replace(/^@/, "")).filter((d) => d.includes(".")),
    coupons: cleanList(r.coupons, (c) => String(c || "").trim().toUpperCase()),
  };
}

async function getRules() {
  return normalizeRules((await getSetting("internal")) || {});
}

/** Does this email / coupon match the test list? Returns a reason string or null. */
function matchRules(rules, { email, couponCode }) {
  const e = String(email || "").toLowerCase();
  if (e && rules.emails.includes(e)) return `email ${e}`;
  const domain = e.split("@")[1];
  if (domain && rules.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return `domain ${domain}`;
  const c = String(couponCode || "").toUpperCase();
  if (c && rules.coupons.includes(c)) return `coupon ${c}`;
  return null;
}

/**
 * Re-applies the rules to every contact (after the lists change).
 * Flags new matches, unflags rule-flagged contacts that no longer match,
 * leaves manual choices alone.
 */
async function applyRulesToAll(conn = db) {
  const rules = await getRules();
  const [contacts] = await conn.execute(
    `SELECT c.id, c.primary_email, c.is_internal, c.internal_reason,
            (SELECT GROUP_CONCAT(DISTINCT UPPER(o.coupon_code)) FROM orders o WHERE o.contact_id = c.id AND o.coupon_code IS NOT NULL) AS coupons,
            (SELECT GROUP_CONCAT(ci.value) FROM contact_identifiers ci WHERE ci.contact_id = c.id AND ci.type = 'email') AS emails
     FROM contacts c WHERE c.merged_into_id IS NULL`,
  );
  let flagged = 0;
  let unflagged = 0;
  for (const c of contacts) {
    if (c.internal_reason === "manual") continue;
    const emails = (c.emails || c.primary_email || "").split(",").filter(Boolean);
    const coupons = (c.coupons || "").split(",").filter(Boolean);
    const hit =
      emails.some((email) => matchRules(rules, { email })) || coupons.some((couponCode) => matchRules(rules, { couponCode }));
    if (hit && !Number(c.is_internal)) {
      await conn.execute("UPDATE contacts SET is_internal = 1, internal_reason = 'rule' WHERE id = ?", [c.id]);
      flagged += 1;
    } else if (!hit && Number(c.is_internal) && c.internal_reason === "rule") {
      await conn.execute("UPDATE contacts SET is_internal = 0, internal_reason = NULL WHERE id = ?", [c.id]);
      unflagged += 1;
    }
  }
  return { flagged, unflagged };
}

async function saveRules(rules, userId) {
  const clean = normalizeRules(rules);
  await setSetting("internal", clean, userId);
  return clean;
}

module.exports = { getRules, matchRules, applyRulesToAll, saveRules, normalizeRules };
