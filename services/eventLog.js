// services/eventLog.js — writes rows to the events table.

const db = require("../config/mysql");
const sandbox = require("../config/sandbox");

const SECRET_KEYS = new Set(["signature", "password", "api_key", "apikey", "token"]);

/** Removes secret-looking keys and caps size before storing a raw payload. */
function sanitizePayload(payload) {
  if (payload === undefined || payload === null) return null;
  let copy;
  try {
    copy = JSON.parse(
      JSON.stringify(payload, (key, value) => (SECRET_KEYS.has(String(key).toLowerCase()) ? "[removed]" : value)),
    );
  } catch {
    return { unserializable: true };
  }
  const json = JSON.stringify(copy);
  if (json.length > 60000) return { truncated: true, preview: json.slice(0, 2000) };
  return copy;
}

function toJson(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * @param {object} e
 * @param {import('mysql2/promise').PoolConnection} [conn] use inside a transaction
 */
async function insertEvent(e, conn = db) {
  // Sandbox: never store a raw payload or email that is not a test identity.
  if (sandbox.isSandbox() && e.emailRaw && !String(e.emailRaw).includes("example.test") && !sandbox.isTestIdentity(e.emailRaw)) {
    e = { ...e, emailRaw: sandbox.sanitizeEmailRaw(e.emailRaw), payload: e.payload ? { sandboxSanitized: true } : e.payload };
  }
  const [result] = await conn.execute(
    `INSERT INTO events
       (contact_id, source, type, status, dedupe_key, matched_by, email_raw, summary,
        details, payload, error, stage_before, stage_after, created_by, import_batch_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.contactId ?? null,
      e.source,
      e.type,
      e.status || "processed",
      e.dedupeKey ?? null,
      e.matchedBy ?? null,
      e.emailRaw != null ? String(e.emailRaw).slice(0, 320) : null,
      e.summary ? String(e.summary).slice(0, 500) : null,
      toJson(e.details),
      toJson(sanitizePayload(e.payload)),
      e.error ? String(e.error).slice(0, 500) : null,
      e.stageBefore ?? null,
      e.stageAfter ?? null,
      e.createdBy ?? null,
      e.importBatchId ?? null,
      e.occurredAt ?? null,
    ],
  );
  return result.insertId;
}

module.exports = { insertEvent, sanitizePayload };
