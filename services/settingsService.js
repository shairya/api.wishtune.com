// services/settingsService.js — small JSON key/value store (settings table).

const db = require("../config/mysql");

const DEFAULTS = {
  bots: {
    voice: { enabled: false, provider: "teleagent" },
    whatsapp: { enabled: false, provider: "wylto" },
    delayMinutes: 10,
    eligibleStages: ["contact", "subscriber", "customer", "repeat_buyer"],
    businessHours: { start: "09:00", end: "21:00" },
    batchSize: 20,
    maxAttempts: 3,
  },
};

async function getSetting(key) {
  const [rows] = await db.execute("SELECT setting_value FROM settings WHERE setting_key = ?", [key]);
  let value = rows[0]?.setting_value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const def = DEFAULTS[key];
  if (def && value && typeof value === "object" && !Array.isArray(value)) return { ...def, ...value };
  return value ?? def ?? null;
}

async function setSetting(key, value, userId = null) {
  await db.execute(
    `INSERT INTO settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify(value), userId],
  );
}

module.exports = { getSetting, setSetting, DEFAULTS };
