/**
 * scripts/sandboxCopyFromProd.js — fills the SANDBOX database with an
 * anonymised copy of production, for realistic testing without real data.
 *
 * Run it from the SANDBOX backend folder (its .env must have SANDBOX_MODE=true
 * and a sandbox database). Production is read with a separate login:
 *
 *   PROD_MYSQL_HOST=localhost PROD_MYSQL_USER=wishtune_ro PROD_MYSQL_PASSWORD=… PROD_MYSQL_DB=wishtune_crm \
 *     npm run sandbox:copy-from-prod -- --yes
 *
 * (The PROD_* values can also go in the sandbox .env. A read-only MySQL user
 * for production is recommended: GRANT SELECT ON wishtune_crm.* TO 'wishtune_ro'@'localhost'.)
 *
 * What is copied, and how it is cleaned:
 *   contacts            emails → contact-<id>@example.test, names → "Test <id>",
 *                       mobile → removed, state → removed; stages, counts, dates,
 *                       country, page, UTM, consent, test flag kept
 *   contact_identifiers emails rewritten as above; mobiles dropped
 *   orders/order_items  kept (amounts, products, coupons, dates — no personal data);
 *                       state removed
 *   products/prices     kept
 *   events              type/status/stages/dates kept; raw payloads, details and
 *                       raw emails removed; messages and notes replaced
 *   settings            test list kept without its email addresses; bots forced OFF
 *   import_batches      kept without reports
 * NOT copied: admin logins, sessions, bot_outreach, merge snapshots.
 *
 * The sandbox database is emptied first (its admin logins are kept).
 */

require("dotenv").config();
const mysql = require("mysql2/promise");
const sandbox = require("../config/sandbox");

const YES = process.argv.includes("--yes");
const BATCH = 500;

function fail(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

const fakeEmail = (contactId) => `contact-${contactId}@example.test`;

async function connect(prefix) {
  const env = (k, d) => process.env[`${prefix}${k}`] ?? d;
  return mysql.createConnection({
    host: env("MYSQL_HOST", "localhost"),
    port: Number(env("MYSQL_PORT", 3306)),
    user: env("MYSQL_USER", "root"),
    password: env("MYSQL_PASSWORD", ""),
    database: env("MYSQL_DB", undefined),
    timezone: "Z",
    dateStrings: false,
    supportBigNumbers: true,
  });
}

async function insertRows(conn, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((r) =>
      cols.map((c) => {
        const v = r[c];
        if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
        return v;
      }),
    );
    await conn.query(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES ?`, [values]);
  }
}

async function main() {
  if (!sandbox.isSandbox()) fail("Refusing: SANDBOX_MODE is not true in this .env. Run this from the sandbox backend folder.");
  try {
    sandbox.assertSafeEnvironment();
  } catch (err) {
    fail(`Refusing: ${err.message}`);
  }
  if (!process.env.PROD_MYSQL_DB) fail("Set PROD_MYSQL_DB (and PROD_MYSQL_USER / PROD_MYSQL_PASSWORD / PROD_MYSQL_HOST) for the production database.");
  const sameHost = (process.env.PROD_MYSQL_HOST || "localhost") === (process.env.MYSQL_HOST || "localhost");
  if (sameHost && process.env.PROD_MYSQL_DB === process.env.MYSQL_DB) fail("Refusing: production and sandbox are the same database.");

  console.log(`Copy (anonymised): ${process.env.PROD_MYSQL_DB}  →  ${process.env.MYSQL_DB}`);
  if (!YES) fail("This empties the sandbox database first. Re-run with --yes to continue.");

  const prod = await connect("PROD_");
  const dev = await connect("");
  try {
    const q = async (sql) => (await prod.query(sql))[0];

    // Read everything first (production is only read, never written).
    const contacts = await q("SELECT * FROM contacts");
    const identifiers = await q("SELECT * FROM contact_identifiers WHERE type = 'email'");
    const orders = await q("SELECT * FROM orders");
    const items = await q("SELECT * FROM order_items");
    const products = await q("SELECT * FROM products");
    const prices = await q("SELECT * FROM product_prices");
    const events = await q("SELECT * FROM events");
    const batches = await q("SELECT * FROM import_batches");
    const settings = await q("SELECT * FROM settings");

    await dev.beginTransaction();
    await dev.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [
      "bot_outreach", "order_items", "orders", "events", "contact_identifiers", "contact_merges",
      "contacts", "product_prices", "products", "import_batches", "settings",
    ]) {
      await dev.query(`DELETE FROM \`${t}\``);
    }

    await insertRows(dev, "products", products);
    await insertRows(dev, "product_prices", prices);

    await insertRows(
      dev,
      "contacts",
      contacts.map((c) => ({
        ...c,
        primary_email: c.primary_email ? fakeEmail(c.id) : null,
        primary_mobile: null,
        mobile_added_at: null,
        first_name: "Test",
        last_name: String(c.id),
        state: null,
      })),
    );
    // One email identifier per contact (a contact may have had several emails).
    const one = new Map();
    for (const i of identifiers) if (!one.has(i.contact_id) || i.is_primary) one.set(i.contact_id, i);
    await insertRows(
      dev,
      "contact_identifiers",
      [...one.values()].map((i) => ({ ...i, value: fakeEmail(i.contact_id), value_raw: fakeEmail(i.contact_id), is_primary: 1 })),
    );

    await insertRows(dev, "import_batches", batches.map((b) => ({ ...b, report: null, run_by: b.run_by ? "admin" : null })));
    await insertRows(dev, "orders", orders.map((o) => ({ ...o, state: null })));
    await insertRows(dev, "order_items", items);

    const scrubSummary = (e) => {
      if (e.type === "contact_message") return "Contact message: [removed in sandbox copy]";
      if (e.type === "note") return "[note removed in sandbox copy]";
      if (e.type === "contact_updated") return "Edited (details removed in sandbox copy)";
      if (/^bot_/.test(e.type)) return `${e.type.replace("_", " ")} (details removed in sandbox copy)`;
      return String(e.summary || "").replace(/[^\s@()<>,;:"]+@[^\s@()<>,;:"]+\.[A-Za-z]{2,}/g, "[email]").replace(/\+?\d[\d\s-]{8,}\d/g, "[number]");
    };
    await insertRows(
      dev,
      "events",
      events.map((e) => ({
        ...e,
        email_raw: e.contact_id ? fakeEmail(e.contact_id) : e.email_raw ? "[removed]" : null,
        summary: scrubSummary(e),
        details: null,
        payload: null,
        error: e.error ? String(e.error).replace(/"[^"]*"/g, '"[removed]"') : null,
        created_by: null,
      })),
    );

    for (const s of settings) {
      let value = s.setting_value;
      if (typeof value === "string") value = JSON.parse(value);
      if (s.setting_key === "bots") value = { ...value, voice: { ...value.voice, enabled: false }, whatsapp: { ...value.whatsapp, enabled: false } };
      if (s.setting_key === "internal") value = { ...value, emails: [] }; // team emails are personal data too; domains/coupons kept
      await dev.query("INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)", [s.setting_key, JSON.stringify(value)]);
    }

    await dev.query("SET FOREIGN_KEY_CHECKS = 1");
    await dev.commit();
    console.log(
      `Done: ${contacts.length} contacts, ${orders.length} orders, ${events.length} events copied — all personal details replaced.\n` +
        "Add your testers to config/sandbox.allowlist.json and give them real mobiles on their contact pages to test the bots.",
    );
  } catch (err) {
    await dev.rollback().catch(() => {});
    throw err;
  } finally {
    await prod.end();
    await dev.end();
  }
}

main().catch((err) => {
  console.error(`\nCopy failed, sandbox unchanged: ${err.message}`);
  process.exit(1);
});
