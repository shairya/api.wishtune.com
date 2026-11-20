/**
 * services/bots/outreachService.js
 *
 * Bots start a conversation only with contacts that have a mobile number.
 * Each run (from jobs/botOutreachCron.js):
 *   - does nothing unless BOTS_ENABLED=true AND a channel is on in Settings
 *     AND that channel's provider has its keys;
 *   - only inside business hours (IST);
 *   - picks contacts with a mobile, not unsubscribed, not test, in an eligible stage,
 *     whose mobile was added at least `delayMinutes` ago, and not yet
 *     reached on that channel (failed attempts retry up to maxAttempts);
 *   - records one bot_outreach row per contact per channel and an event.
 */

const db = require("../../config/mysql");
const { insertEvent } = require("../eventLog");
const { getSetting } = require("../settingsService");
const { getProvider, botsMasterSwitch } = require("./registry");
const sandbox = require("../../config/sandbox");

const STAGES = ["contact", "subscriber", "customer", "repeat_buyer"];

function istMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

function toMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function withinBusinessHours(bh) {
  if (!bh) return true;
  const now = istMinutesNow();
  const start = toMinutes(bh.start, 0);
  const end = toMinutes(bh.end, 24 * 60);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

async function findEligible(channel, s) {
  const stages = (Array.isArray(s.eligibleStages) ? s.eligibleStages : STAGES).filter((x) => STAGES.includes(x));
  if (!stages.length) return [];
  const limit = Math.min(Math.max(parseInt(s.batchSize, 10) || 20, 1), 200);
  const delay = Math.max(parseInt(s.delayMinutes, 10) || 0, 0);
  const maxAttempts = Math.max(parseInt(s.maxAttempts, 10) || 1, 1);
  // Sandbox: only allowlisted numbers can ever be picked (and the provider re-checks).
  let sandboxClause = "";
  let sandboxParams = [];
  if (sandbox.isSandbox()) {
    const mobiles = [...sandbox.getAllowlist().mobiles];
    if (!mobiles.length) return [];
    sandboxClause = `AND c.primary_mobile IN (${mobiles.map(() => "?").join(",")})`;
    sandboxParams = mobiles;
  }
  const [rows] = await db.execute(
    `SELECT c.id, c.primary_email AS email, CONCAT_WS(' ', c.first_name, c.last_name) AS name,
            c.first_name, c.primary_mobile AS mobile, c.stage
     FROM contacts c
     WHERE c.primary_mobile IS NOT NULL
       AND c.unsubscribed = 0
       AND c.is_internal = 0
       AND c.merged_into_id IS NULL
       ${sandboxClause}
       AND c.stage IN (${stages.map(() => "?").join(",")})
       AND c.mobile_added_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${delay} MINUTE)
       AND NOT EXISTS (
         SELECT 1 FROM bot_outreach b
         WHERE b.contact_id = c.id AND b.channel = ?
           AND (b.status IN ('queued','sent','completed','skipped')
                OR b.attempts >= ${maxAttempts}
                OR b.updated_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${Math.max(delay, 15)} MINUTE))
       )
     ORDER BY c.mobile_added_at ASC
     LIMIT ${limit}`,
    [...sandboxParams, ...stages, channel],
  );
  return rows;
}

async function reachContact(contact, channel, provider) {
  await db.execute(
    `INSERT INTO bot_outreach (contact_id, channel, provider, status, attempts, mobile)
     VALUES (?, ?, ?, 'queued', 1, ?)
     ON DUPLICATE KEY UPDATE status = 'queued', attempts = attempts + 1,
       provider = VALUES(provider), mobile = VALUES(mobile), last_error = NULL`,
    [contact.id, channel, provider.name, contact.mobile],
  );
  try {
    const result = await provider.start(contact);
    await db.execute(
      "UPDATE bot_outreach SET status = 'sent', external_id = ?, result = ? WHERE contact_id = ? AND channel = ?",
      [result.externalId, JSON.stringify(result.raw || {}), contact.id, channel],
    );
    await insertEvent({
      contactId: contact.id,
      source: "bot",
      type: `bot_${channel}`,
      summary: `${provider.label} ${channel === "voice" ? "call placed" : "WhatsApp sent"} to ${contact.mobile}`,
      details: { provider: provider.name, externalId: result.externalId, status: result.status },
    });
    return true;
  } catch (err) {
    const blocked = err instanceof sandbox.SandboxBlockedError;
    await db.execute(
      `UPDATE bot_outreach SET status = '${blocked ? "skipped" : "failed"}', last_error = ? WHERE contact_id = ? AND channel = ?`,
      [String(err.message).slice(0, 500), contact.id, channel],
    );
    await insertEvent({
      contactId: contact.id,
      source: "bot",
      type: `bot_${channel}`,
      status: "rejected",
      summary: `${provider.label} ${channel} attempt failed`,
      error: err.message,
      details: { provider: provider.name },
    });
    return false;
  }
}

/** One pass. Returns a small report (also used by the "Run now" button). */
async function runOutreachOnce({ force = false } = {}) {
  const report = { ran: false, reason: null, channels: {}, sandbox: sandbox.isSandbox() };
  if (sandbox.isSandbox() && !sandbox.getAllowlist().mobiles.size) {
    report.reason = `Sandbox: no valid mobile numbers in ${sandbox.getAllowlist().file} — nobody can be contacted`;
    return report;
  }
  if (!botsMasterSwitch()) {
    report.reason = "BOTS_ENABLED is not true in .env";
    return report;
  }
  const s = await getSetting("bots");
  if (!force && !withinBusinessHours(s.businessHours)) {
    report.reason = "Outside business hours";
    return report;
  }

  // Anything stuck in 'queued' for 30+ min (process restarted mid-request) counts as failed.
  await db.execute(
    `UPDATE bot_outreach SET status = 'failed', last_error = 'Interrupted'
     WHERE status = 'queued' AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE)`,
  );

  for (const channel of ["voice", "whatsapp"]) {
    const cfg = s[channel] || {};
    if (!cfg.enabled) {
      report.channels[channel] = "off";
      continue;
    }
    const provider = getProvider(cfg.provider);
    if (!provider || provider.channel !== channel) {
      report.channels[channel] = `unknown provider "${cfg.provider}"`;
      continue;
    }
    if (!provider.isConfigured()) {
      report.channels[channel] = `${provider.label} missing ${provider.missingConfig().join(", ")}`;
      continue;
    }
    const contacts = await findEligible(channel, s);
    let ok = 0;
    for (const c of contacts) {
      // Re-check right before contacting: unsubscribed in the meantime?
      const [fresh] = await db.execute(
        "SELECT unsubscribed, is_internal, primary_mobile AS mobile FROM contacts WHERE id = ?",
        [c.id],
      );
      if (!fresh[0] || Number(fresh[0].unsubscribed) || Number(fresh[0].is_internal) || !fresh[0].mobile) continue;
      if (await reachContact({ ...c, mobile: fresh[0].mobile }, channel, provider)) ok += 1;
    }
    report.channels[channel] = `${ok}/${contacts.length} reached`;
  }
  report.ran = true;
  return report;
}

module.exports = { runOutreachOnce, withinBusinessHours, findEligible };
