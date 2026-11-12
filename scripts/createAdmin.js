/**
 * scripts/createAdmin.js — creates an admin login (run once per person).
 *
 *   npm run create-admin
 *
 * Non-interactive (e.g. over SSH scripts):
 *   ADMIN_NAME="Ria" ADMIN_EMAIL=you@x.com ADMIN_PASSWORD='...' npm run create-admin
 */

require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const db = require("../config/mysql");

function ask(rl, q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(q, (a) => resolve(a.trim()));
    // Show * instead of the typed password.
    rl.output.write(q);
    rl.muted = true;
    rl.question("", (a) => {
      rl.muted = false;
      rl.output.write("\n");
      resolve(a);
    });
  });
}

async function main() {
  console.log("\n=== Wishtune CRM — create admin login ===\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // eslint-disable-next-line no-underscore-dangle
  rl._writeToOutput = (s) => rl.output.write(rl.muted ? s.replace(/[^\r\n]/g, "*") : s);
  try {
    const fullName = process.env.ADMIN_NAME || (await ask(rl, "Full name: "));
    const email = (process.env.ADMIN_EMAIL || (await ask(rl, "Email: "))).toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || (await ask(rl, "Password (min 10 chars): ", { hidden: true }));

    if (!fullName || !email || !password) throw new Error("All fields are required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That email does not look valid");
    if (password.length < 10) throw new Error("Password must be at least 10 characters");

    const hash = await bcrypt.hash(password, 12);
    const [r] = await db.execute(
      "INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', 1)",
      [fullName, email, hash],
    );
    console.log(`\nAdmin created (user id ${r.insertId}). Sign in at ${process.env.APP_URL || "the CRM"} with ${email}.`);
  } catch (err) {
    console.error(`\nError: ${err.code === "ER_DUP_ENTRY" ? "that email already has a login (use npm run reset-password)" : err.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
    await db.end();
  }
}

main();
