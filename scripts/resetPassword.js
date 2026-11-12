/**
 * scripts/resetPassword.js — sets a new password and signs the user out everywhere.
 *
 *   npm run reset-password
 *   (or ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run reset-password)
 */

require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const db = require("../config/mysql");

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
  try {
    const email = (process.env.ADMIN_EMAIL || (await ask("Email: "))).toLowerCase();
    const password = process.env.ADMIN_PASSWORD || (await ask("New password (min 10 chars): "));
    if (password.length < 10) throw new Error("Password must be at least 10 characters");
    const [r] = await db.execute("UPDATE users SET password_hash = ?, is_active = 1 WHERE email = ?", [
      await bcrypt.hash(password, 12),
      email,
    ]);
    if (!r.affectedRows) throw new Error(`No login found for ${email}`);
    await db.execute(
      "UPDATE refresh_tokens rt JOIN users u ON u.id = rt.user_id SET rt.is_revoked = 1 WHERE u.email = ?",
      [email],
    );
    console.log(`Password updated for ${email}.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
    await db.end();
  }
}

main();
