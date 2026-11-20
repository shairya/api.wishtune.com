/**
 * config/sandbox.js — the sandbox safety layer (devcrm.wishtune.com / devapi.wishtune.com).
 *
 * Turned on with SANDBOX_MODE=true in .env. In sandbox mode:
 *
 *  1. OUTBOUND: bots (voice calls, WhatsApp) — and any future email/SMS — may
 *     only reach people listed in the allowlist file. If the file is missing,
 *     empty or invalid, NOTHING is sent (fails closed). Enforced twice: when
 *     picking contacts (services/bots/outreachService.js) and again in front
 *     of every provider (services/bots/registry.js).
 *
 *  2. INBOUND: any event whose email is not an allowlisted tester or a test
 *     domain (example.com, example.test, …) is anonymised on arrival — email
 *     replaced, name/mobile/message/raw payload dropped — so real customer
 *     data never lands in the sandbox, even if a real form or the real Payhip
 *     webhook is pointed at it by mistake.
 *
 *  3. DATABASE: the server refuses to start unless MYSQL_DB looks like a
 *     sandbox database (name contains dev / sandbox / test / staging).
 *
 * Allowlist file (default config/sandbox.allowlist.json, override with
 * SANDBOX_ALLOWLIST_FILE). It is re-read automatically when it changes.
 * {
 *   "users": [
 *     { "name": "Ria",    "email": "ria@example.com",  "mobile": "+91 98xxxxxxxx" },
 *     { "name": "Tester", "email": "qa@xlncacademy.com", "mobile": "98xxxxxxxx" }
 *   ],
 *   "testEmailDomains": ["example.com", "example.test"]
 * }
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { normalizeEmail, normalizeMobile, cleanText } = require("../lib/normalize");

const ALWAYS_TEST_DOMAINS = ["example.com", "example.org", "example.net", "example.test"];

function isSandbox() {
  return String(process.env.SANDBOX_MODE || "").toLowerCase() === "true";
}

function allowlistPath() {
  return path.resolve(process.env.SANDBOX_ALLOWLIST_FILE || path.join(__dirname, "sandbox.allowlist.json"));
}

let cache = { mtimeMs: -1, file: null, data: null };

/** @returns {{ users: {name:string,email:string|null,mobile:string|null}[], emails:Set<string>, mobiles:Set<string>, domains:string[], error:string|null, file:string }} */
function getAllowlist() {
  const file = allowlistPath();
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  if (cache.file === file && cache.mtimeMs === (stat ? stat.mtimeMs : 0) && cache.data) return cache.data;

  const empty = (error) => ({ users: [], emails: new Set(), mobiles: new Set(), domains: [...ALWAYS_TEST_DOMAINS], error, file });
  let data;
  if (!stat) data = empty(`Allowlist file not found: ${file}`);
  else {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const users = (Array.isArray(raw.users) ? raw.users : []).map((u) => {
        const e = normalizeEmail(u.email);
        return { name: cleanText(u.name, 100) || "", email: e.ok ? e.email : null, mobile: normalizeMobile(u.mobile) };
      });
      const domains = [
        ...ALWAYS_TEST_DOMAINS,
        ...(Array.isArray(raw.testEmailDomains) ? raw.testEmailDomains : [])
          .map((d) => String(d || "").trim().toLowerCase().replace(/^@/, ""))
          .filter((d) => d.includes(".")),
      ];
      data = {
        users,
        emails: new Set(users.map((u) => u.email).filter(Boolean)),
        mobiles: new Set(users.map((u) => u.mobile).filter(Boolean)),
        domains: [...new Set(domains)],
        error: null,
        file,
      };
    } catch (err) {
      data = empty(`Allowlist file is not valid JSON (${err.message}) — nothing will be sent`);
    }
  }
  cache = { mtimeMs: stat ? stat.mtimeMs : 0, file, data };
  return data;
}

/* ----------------------------- outbound ----------------------------- */

/** May a call / WhatsApp go to this number? Always true outside sandbox mode. */
function canContactMobile(mobile) {
  if (!isSandbox()) return true;
  const m = normalizeMobile(mobile);
  return Boolean(m) && getAllowlist().mobiles.has(m);
}

/** May an email go to this address? (For future email features.) Always true outside sandbox mode. */
function canEmail(email) {
  if (!isSandbox()) return true;
  const e = normalizeEmail(email);
  return e.ok && getAllowlist().emails.has(e.email);
}

class SandboxBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxBlockedError";
  }
}

/* ----------------------------- inbound ------------------------------ */

/** Allowlisted tester or a test domain → kept as-is in the sandbox. */
function isTestIdentity(email) {
  const e = normalizeEmail(email);
  if (!e.ok) return false;
  const list = getAllowlist();
  if (list.emails.has(e.email)) return true;
  const domain = e.email.split("@")[1];
  return list.domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function fakeEmail(email) {
  const hash = crypto.createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 10);
  return `sbx-${hash}@example.test`;
}

/**
 * Returns the event to process. Outside sandbox mode, or for test identities,
 * it is unchanged; otherwise personal data is replaced. Invalid emails stay
 * invalid (so rejection still works) but the raw value is not stored.
 */
function sanitizeEvent(evt) {
  if (!isSandbox()) return evt;
  const check = normalizeEmail(evt.emailRaw);
  if (check.ok && isTestIdentity(check.email)) return evt;

  const out = {
    ...evt,
    emailRaw: check.ok ? fakeEmail(check.email) : evt.emailRaw ? "[invalid email, sanitized]" : evt.emailRaw,
    name: null,
    firstName: null,
    lastName: null,
    mobile: null,
    state: null,
    message: evt.message ? "[message removed in sandbox]" : evt.message,
    payload: { sandboxSanitized: true },
    extra: { ...(evt.extra || {}), sandboxSanitized: true, formFields: undefined },
  };
  if (evt.sale) out.sale = { ...evt.sale, state: null };
  return out;
}

/** For refunds and other raw-email paths. */
function sanitizeEmailRaw(emailRaw) {
  if (!isSandbox()) return emailRaw;
  const check = normalizeEmail(emailRaw);
  if (check.ok && isTestIdentity(check.email)) return emailRaw;
  return check.ok ? fakeEmail(check.email) : "[invalid email, sanitized]";
}

/* ----------------------------- startup ------------------------------ */

const SANDBOX_DB_RE = /(dev|sandbox|test|staging)/i;

/** Throws when sandbox mode is on but the database does not look like a sandbox one. */
function assertSafeEnvironment() {
  if (!isSandbox()) return;
  const dbName = process.env.MYSQL_DB || "";
  if (!SANDBOX_DB_RE.test(dbName)) {
    throw new Error(
      `SANDBOX_MODE=true but MYSQL_DB="${dbName}" does not look like a sandbox database. ` +
        'Use a separate database whose name contains "dev", "sandbox", "test" or "staging" (e.g. wishtune_crm_dev).',
    );
  }
}

/** Short status for logs and the Settings page. */
function describe() {
  if (!isSandbox()) return { enabled: false };
  const list = getAllowlist();
  return {
    enabled: true,
    allowlistFile: list.file,
    error: list.error,
    users: list.users,
    testEmailDomains: list.domains,
  };
}

module.exports = {
  isSandbox,
  getAllowlist,
  canContactMobile,
  canEmail,
  isTestIdentity,
  sanitizeEvent,
  sanitizeEmailRaw,
  assertSafeEnvironment,
  describe,
  SandboxBlockedError,
  SANDBOX_DB_RE,
};
