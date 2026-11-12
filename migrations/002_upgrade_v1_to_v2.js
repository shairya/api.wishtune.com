/**
 * 002_upgrade_v1_to_v2.js
 *
 * Servers that already ran the first version of 001 (contacts keyed by an
 * `email` column, money in paise) are moved to schema v2. That first
 * version went live with no data, so the contact/order tables are rebuilt
 * from the current 001 file. Logins (users, refresh_tokens) and settings
 * are kept.
 *
 * Safety: if any contact or order exists, it stops and changes nothing.
 * On a fresh install (001 already v2) it does nothing.
 */

const fs = require("fs");
const path = require("path");

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(rows[0].n) > 0;
}

async function count(conn, table) {
  const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n);
}

module.exports.up = async function up(conn, { dir }) {
  const isV1 = (await columnExists(conn, "contacts", "email")) && !(await columnExists(conn, "contacts", "primary_email"));
  if (!isV1) return "already on schema v2";

  const contacts = await count(conn, "contacts");
  const orders = await count(conn, "orders");
  if (contacts > 0 || orders > 0) {
    throw new Error(
      `The v1 database has ${contacts} contact(s) and ${orders} order(s). This upgrade only runs on an empty CRM. ` +
        "Back up the data, empty those tables, and run the migration again.",
    );
  }

  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const t of ["bot_outreach", "order_items", "orders", "events", "products", "contacts"]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
  } finally {
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  }
  // Re-run the v2 schema: CREATE ... IF NOT EXISTS + INSERT IGNORE, so users/settings stay.
  await conn.query(fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf8"));
  return "rebuilt contact/order tables on schema v2";
};
