/**
 * scripts/runMigrations.js — applies pending migrations in filename order,
 * tracked in schema_migrations, so re-running is always safe.
 *
 *   npm run migrate
 *
 * A migration is either NNN_name.sql (run as-is) or NNN_name.js exporting
 * `async up(conn, { dir })` for steps that need checks before changing data.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const DIR = path.join(__dirname, "..", "migrations");

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DB || "wishtune_crm",
    multipleStatements: true,
    timezone: "Z",
  });
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const [rows] = await conn.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.filename));
    const pending = fs
      .readdirSync(DIR)
      .filter((f) => /^\d+_.*\.(sql|js)$/.test(f))
      .sort()
      .filter((f) => !applied.has(f));

    if (!pending.length) {
      console.log("No pending migrations. Database is up to date.");
      return;
    }
    for (const file of pending) {
      process.stdout.write(`Applying ${file}... `);
      const full = path.join(DIR, file);
      if (file.endsWith(".js")) {
        const result = await require(full).up(conn, { dir: DIR });
        if (result) process.stdout.write(`(${result}) `);
      } else {
        await conn.query(fs.readFileSync(full, "utf8"));
      }
      await conn.query("INSERT INTO schema_migrations (filename) VALUES (?)", [file]);
      console.log("done");
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
