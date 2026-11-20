/**
 * test/runEventChecklist.js — the spec's hand-over test list, automated.
 *
 * Sends correctly signed requests to a running CRM and checks the database:
 *   1. Payhip sale            → new contact, stage Customer, count 1, campaign "unknown"
 *   2. Sign-up                → new contact, Subscriber, UTM + consent saved
 *   3. Contact message        → new contact, stage Contact
 *   4. Second sale, same email→ Repeat buyer, count 2
 *   5. Invalid email          → rejected + logged, no contact
 *   6. Duplicate Payhip order → logged as duplicate, count unchanged
 * plus: stages never move back, UTM never overwritten, empty never overwrites
 * filled, Netlify retry de-duplicated, bad signatures refused.
 *
 *   node test/runEventChecklist.js                  # against http://127.0.0.1:$PORT
 *   node test/runEventChecklist.js --base https://crm.wishtune.com
 *   node test/runEventChecklist.js --cleanup        # delete this script's test contacts afterwards
 *
 * Test emails look like crmtest-<run>-a@example.com, so they are easy to spot.
 * Needs the same .env as the server (PAYHIP_API_KEY, NETLIFY_JWS_SECRET, MYSQL_*).
 */

require("dotenv").config();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../config/mysql");

const args = process.argv.slice(2);
const BASE = (args[args.indexOf("--base") + 1] && args.includes("--base")
  ? args[args.indexOf("--base") + 1]
  : `http://127.0.0.1:${process.env.PORT || 5100}`).replace(/\/+$/, "");
const CLEANUP = args.includes("--cleanup");
const ORIGIN = (process.env.SIGNUP_ALLOWED_ORIGINS || "https://wishtune.com").split(",")[0].trim();

const run = Date.now().toString(36);
const A = `crmtest-${run}-a@example.com`;
const B = `crmtest-${run}-b@example.com`;
const C = `crmtest-${run}-c@example.com`;
const order1 = `TEST-${run}-1`;
const order2 = `TEST-${run}-2`;

let failures = 0;
let SANDBOX = false; // set from /api/health: sandbox anonymises non-test identities by design
function check(label, cond, extra = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${!cond && extra ? `  (${extra})` : ""}`);
  if (!cond) failures += 1;
}

async function post(path, body, headers = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

function payhipSale(email, orderId, { price = 149900, product = "TEST-KEY", name = "Shower Mixtape — Love" } = {}) {
  return {
    id: orderId,
    email,
    currency: "INR",
    price,
    items: [
      {
        product_id: "999001",
        product_name: name,
        product_key: product,
        product_permalink: "TestLove",
        quantity: "1",
        on_sale: false,
        used_coupon: true,
      },
    ],
    payment_type: "card",
    unconsented_from_emails: false,
    is_gift: false,
    date: Math.floor(Date.now() / 1000),
    type: "paid",
    signature: crypto.createHash("sha256").update(process.env.PAYHIP_API_KEY || "").digest("hex"),
  };
}

function netlifyHeaders(body) {
  const sha256 = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const token = jwt.sign({ iss: "netlify", sha256 }, process.env.NETLIFY_JWS_SECRET || "x", { algorithm: "HS256" });
  return { "X-Webhook-Signature": token };
}

async function contact(email) {
  const [rows] = await db.execute(
    "SELECT c.* FROM contact_identifiers ci JOIN contacts c ON c.id = ci.contact_id WHERE ci.type = 'email' AND ci.value = ?",
    [email],
  );
  return rows[0] || null;
}

async function main() {
  console.log(`Wishtune CRM checklist → ${BASE}  (run ${run})\n`);
  try {
    SANDBOX = Boolean((await (await fetch(`${BASE}/api/health`)).json()).sandbox);
  } catch {
    SANDBOX = false;
  }
  if (SANDBOX) console.log("Sandbox detected: checks that need real (non-test) identities are skipped.\n");
  if (!process.env.PAYHIP_API_KEY || !process.env.NETLIFY_JWS_SECRET) {
    console.error("PAYHIP_API_KEY and NETLIFY_JWS_SECRET must be set in .env to sign test requests.");
    process.exit(1);
  }

  console.log("Security");
  let r = await post("/webhooks/payhip", { ...payhipSale(A, `${order1}-forged`), signature: "0".repeat(64) });
  check("Payhip webhook with wrong signature is refused (401)", r.status === 401, `got ${r.status}`);
  r = await post("/webhooks/contact", { data: { email: C } }, { "X-Webhook-Signature": "bad" });
  check("Contact webhook with bad JWS is refused (401)", r.status === 401, `got ${r.status}`);
  r = await post("/api/signup", { email: B, consent: "yes" }, { Origin: "https://evil.example" });
  check("Sign-up from another website is refused (403)", r.status === 403, `got ${r.status}`);
  check("Nothing was created by refused requests", !(await contact(A)) && !(await contact(B)) && !(await contact(C)));

  console.log("\n1. Payhip sale");
  r = await post("/webhooks/payhip", payhipSale(A, order1));
  let a = await contact(A);
  check("accepted (200, processed)", r.status === 200 && r.json?.status === "processed", JSON.stringify(r.json));
  check("contact created, stage customer", a?.stage === "customer", a?.stage);
  check("purchase count 1", Number(a?.purchase_count) === 1);
  check("lead source buyer", a?.lead_source === "buyer");
  check('campaign "unknown" (no earlier sign-up)', a?.utm_campaign === "unknown", a?.utm_campaign);
  const [o1] = await db.execute("SELECT currency, amount_gross, is_free FROM orders WHERE payhip_order_id = ?", [order1]);
  check("amount stored as ₹1,499 (Payhip sends paise)", o1[0]?.currency === "INR" && Number(o1[0]?.amount_gross) === 1499, JSON.stringify(o1[0]));
  check("counted as a paid purchase", Number(a?.paid_purchase_count) === 1);
  const [it] = await db.execute(
    "SELECT p.product_code FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id WHERE o.payhip_order_id = ?",
    [order1],
  );
  check("item matched to MT-001 by name", it[0]?.product_code === "MT-001", it[0]?.product_code);

  console.log("\n2. Sign-up");
  r = await post(
    "/api/signup",
    {
      email: `  ${B.toUpperCase()} `,
      mobile: "98765 43210",
      first_page_seen: "/love",
      utm_source: "facebook",
      utm_medium: "paid_social",
      utm_campaign: "love_oct",
      consent: "yes",
    },
    { Origin: ORIGIN },
  );
  let b = await contact(B);
  check("accepted (200)", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  check("email trimmed + lowercased, one record", Boolean(b));
  check("stage subscriber", b?.stage === "subscriber", b?.stage);
  check("page saved as 'love'", b?.first_page_seen === "love", b?.first_page_seen);
  check("UTM saved", b?.utm_source === "facebook" && b?.utm_medium === "paid_social" && b?.utm_campaign === "love_oct");
  check("consent yes + timestamp", Number(b?.email_consent) === 1 && Boolean(b?.email_consent_at));
  check("mobile normalised to +919876543210", b?.primary_mobile === "+919876543210", b?.primary_mobile);

  console.log("\n3. Contact message");
  const msg = {
    id: `sub-${run}`,
    form_name: process.env.NETLIFY_CONTACT_FORM_NAME || "contact",
    created_at: new Date().toISOString(),
    data: { name: "Test Person", email: C, message: "Hello, testing the CRM", referrer: "https://wishtune.com/contact" },
  };
  r = await post("/webhooks/contact", msg, netlifyHeaders(msg));
  let c = await contact(C);
  check("accepted (200, processed)", r.status === 200 && r.json?.status === "processed", JSON.stringify(r.json));
  check("stage contact", c?.stage === "contact", c?.stage);
  check("name saved (first + last)", c?.first_name === "Test" && c?.last_name === "Person");
  r = await post("/webhooks/contact", msg, netlifyHeaders(msg));
  check("Netlify retry of the same submission → duplicate", r.json?.status === "duplicate", JSON.stringify(r.json));

  console.log("\n4. Second sale from the same email");
  r = await post("/webhooks/payhip", payhipSale(A, order2, { price: 99900 }));
  a = await contact(A);
  check("stage repeat_buyer", a?.stage === "repeat_buyer", a?.stage);
  check("purchase count 2", Number(a?.purchase_count) === 2, a?.purchase_count);
  check("still one record for this email", (await db.execute("SELECT COUNT(*) n FROM contact_identifiers WHERE type = 'email' AND value = ?", [A]))[0][0].n == 1);

  console.log("\n5. Invalid email");
  const before = (await db.execute("SELECT COUNT(*) n FROM contacts"))[0][0].n;
  r = await post("/webhooks/payhip", payhipSale(`not-an-email-${run}`, `${order1}-bad`));
  check("Payhip answered 200 with status rejected", r.status === 200 && r.json?.status === "rejected", JSON.stringify(r.json));
  r = await post("/api/signup", { email: `broken@${run}`, consent: "yes" }, { Origin: ORIGIN });
  check("sign-up form gets 400", r.status === 400);
  const after = (await db.execute("SELECT COUNT(*) n FROM contacts"))[0][0].n;
  check("no contact created", Number(after) === Number(before));
  const [rej] = await db.execute(
    "SELECT COUNT(*) n FROM events WHERE status = 'rejected' AND (email_raw = ? OR email_raw = ?)",
    [`not-an-email-${run}`, `broken@${run}`],
  );
  if (!SANDBOX) check("both written to the error log", Number(rej[0].n) === 2, rej[0].n);

  console.log("\n6. Duplicate Payhip order");
  r = await post("/webhooks/payhip", payhipSale(A, order1));
  a = await contact(A);
  check("answered 200 with status duplicate", r.status === 200 && r.json?.status === "duplicate", JSON.stringify(r.json));
  check("purchase count still 2", Number(a?.purchase_count) === 2, a?.purchase_count);
  const [ord] = await db.execute("SELECT COUNT(*) n FROM orders WHERE payhip_order_id = ?", [order1]);
  check("order stored once", Number(ord[0].n) === 1);

  console.log("\nRules");
  r = await post("/api/signup", { email: A, consent: "no", utm_campaign: "late_campaign" }, { Origin: ORIGIN });
  a = await contact(A);
  check("sign-up never moves a buyer back (still repeat_buyer)", a?.stage === "repeat_buyer", a?.stage);
  check('buyer\'s later sign-up keeps campaign "unknown"', a?.utm_campaign === "unknown", a?.utm_campaign);
  r = await post("/api/signup", { email: B, utm_source: "google", utm_campaign: "other", consent: "yes" }, { Origin: ORIGIN });
  b = await contact(B);
  check("UTM never overwritten", b?.utm_source === "facebook" && b?.utm_campaign === "love_oct", `${b?.utm_source}/${b?.utm_campaign}`);
  r = await post("/webhooks/payhip", payhipSale(B, `TEST-${run}-3`));
  b = await contact(B);
  check("subscriber who buys → customer, keeps sign-up campaign", b?.stage === "customer" && b?.utm_campaign === "love_oct");
  check("empty values never blank a filled field (mobile kept)", b?.primary_mobile === "+919876543210", b?.primary_mobile);
  r = await post("/api/signup", { email: C, consent: "yes" }, { Origin: ORIGIN });
  c = await contact(C);
  check("contact who signs up → subscriber", c?.stage === "subscriber", c?.stage);
  r = await post("/webhooks/payhip", payhipSale(C, `TEST-${run}-4`, { price: 0 }));
  c = await contact(C);
  check("100%-off order → Customer, but not a paid purchase", c?.stage === "customer" && Number(c?.paid_purchase_count) === 0);
  const T = `crmtest-${run}-t@xlncacademy.com`;
  r = await post("/webhooks/payhip", payhipSale(T, `TEST-${run}-5`));
  const t = await contact(T);
  if (!SANDBOX) check("team domain from the test list → flagged as test", Number(t?.is_internal) === 1, t?.is_internal);

  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed"}`);

  if (CLEANUP) {
    const like = `crmtest-${run}-%`;
    await db.execute("DELETE FROM events WHERE contact_id IN (SELECT id FROM contacts WHERE primary_email LIKE ?)", [like]);
    await db.execute("DELETE FROM contacts WHERE primary_email LIKE ?", [like]);
    await db.execute("DELETE FROM events WHERE email_raw IN (?, ?)", [`not-an-email-${run}`, `broken@${run}`]);
    console.log("Test contacts removed.");
  }
  await db.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.end().catch(() => {});
  process.exit(1);
});
