/**
 * controllers/botWebhookController.js — POST /webhooks/teleagent and /webhooks/wylto
 *
 * Ready for when the bots go live: stores each callback as an event on
 * the right contact and updates bot_outreach. Auth: a shared secret,
 * sent either as ?token=<secret> on the URL you register with the
 * provider, or as "Authorization: Bearer <secret>". Fails closed when the
 * secret is not set. Swap in the provider's own signature check once
 * they confirm their signing scheme.
 */

const crypto = require("crypto");
const db = require("../config/mysql");
const { insertEvent } = require("../services/eventLog");
const { normalizeMobile } = require("../lib/normalize");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function requireSecret(envName) {
  return (req, res, next) => {
    const secret = process.env[envName];
    if (!secret) return res.status(503).json({ error: `${envName} is not set` });
    const bearer = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (safeEqual(req.query.token, secret) || safeEqual(bearer, secret)) return next();
    return res.status(401).json({ error: "Invalid token" });
  };
}

async function findOutreach(channel, externalId, phone) {
  if (externalId) {
    const [rows] = await db.execute(
      "SELECT * FROM bot_outreach WHERE channel = ? AND external_id = ? LIMIT 1",
      [channel, String(externalId)],
    );
    if (rows[0]) return rows[0];
  }
  const mobile = normalizeMobile(phone);
  if (mobile) {
    const [rows] = await db.execute(
      "SELECT * FROM bot_outreach WHERE channel = ? AND mobile = ? ORDER BY updated_at DESC LIMIT 1",
      [channel, mobile],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

function handler(channel, providerName) {
  return async (req, res) => {
    const b = req.body || {};
    try {
      const externalId = b.callId || b.call_id || b.messageId || b.message_id || b.id || b.data?.callId || null;
      const phone = b.phone || b.from || b.to || b.data?.phone || null;
      const eventName = req.get("X-Teleagent-Event") || b.event || b.type || b.status || "update";
      const outreach = await findOutreach(channel, externalId, phone);

      if (outreach && /complete|ended|finished|read|replied|delivered/i.test(String(eventName))) {
        await db.execute("UPDATE bot_outreach SET status = 'completed', result = ? WHERE id = ?", [
          JSON.stringify(b).slice(0, 60000),
          outreach.id,
        ]);
      }
      await insertEvent({
        contactId: outreach?.contact_id || null,
        source: "bot",
        type: `bot_${channel}_update`,
        status: outreach ? "processed" : "ignored",
        summary: `${providerName}: ${eventName}`,
        error: outreach ? null : "No matching outreach record",
        payload: b,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error(`[${providerName}] webhook failed:`, err);
      return res.status(500).json({ error: "Processing failed" });
    }
  };
}

module.exports = {
  teleagentAuth: requireSecret("TELEAGENT_WEBHOOK_SECRET"),
  wyltoAuth: requireSecret("WYLTO_WEBHOOK_SECRET"),
  teleagent: handler("voice", "TeleAgent"),
  wylto: handler("whatsapp", "Wylto"),
};
