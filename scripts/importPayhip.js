/**
 * scripts/importPayhip.js — imports past Payhip orders from the
 * Customers → Export file (CSV, or the same sheet saved as .xlsx).
 *
 *   npm run import:payhip -- ./Customer_List.csv            # dry run: shows what would happen, saves nothing
 *   npm run import:payhip -- ./Customer_List.csv --commit   # import for real
 *
 * Options:
 *   --commit        write to the database (default is a dry run)
 *   --force         allow importing a file that was already imported (rows are still de-duplicated)
 *   --by "Name"     who ran it (stored on the import record)
 *
 * Every row goes through the same 7-step logic as the live Payhip webhook,
 * oldest first, so stages and purchase counts build up correctly. The
 * Payhip Order ID is the de-duplication key shared with the webhook, so
 * re-running the import, or importing orders the webhook already received,
 * never counts an order twice. The whole file is one transaction: if
 * anything unexpected fails, nothing is saved.
 */

require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../config/mysql");
const { readTable, excelSerialToISODate } = require("../lib/tabular");
const { processEvent } = require("../services/contactEventService");
const { getRules } = require("../services/internalService");
const { toAmount, normCurrency } = require("../lib/money");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--by");
const COMMIT = args.includes("--commit");
const FORCE = args.includes("--force");
const RUN_BY = args.includes("--by") ? args[args.indexOf("--by") + 1] : process.env.USER || null;

// Header names as Payhip exports them (matched case-insensitively).
const COL = {
  orderId: "order id",
  email: "email",
  firstName: "first name",
  lastName: "last name",
  currency: "currency",
  gross: "amount gross",
  net: "amount net",
  status: "status",
  numItems: "num of items in cart",
  items: "items in cart",
  paymentType: "payment type",
  gatewayFee: "paypal/stripe fee",
  payhipFee: "payhip fee",
  unsubscribed: "unsubscribed from email updates",
  unconsented: "unconsented from emails (eu gdpr)",
  couponApplied: "coupon code applied",
  couponCode: "coupon code",
  couponPct: "coupon percentage off",
  couponDiscount: "coupon discount amount",
  country: "country name",
  state: "state name",
  phone: "phone number",
  downloads: "number of downloads",
  date: "date",
};
const REQUIRED = ["orderId", "email", "date"];
const DROP_FROM_PAYLOAD = ["license key", "company vat number", "address line 1", "address line 2", "shipping address"];

function getter(headers) {
  const index = Object.fromEntries(headers.map((h) => [h.trim().toLowerCase(), h]));
  const missing = REQUIRED.filter((k) => !index[COL[k]]).map((k) => COL[k]);
  return { get: (row, key) => (index[COL[key]] ? String(row[index[COL[key]]] ?? "").trim() : ""), missing };
}

const yes = (v) => ["1", "true", "yes", "y"].includes(String(v).trim().toLowerCase());

/** "2026-10-31" (day only) → noon IST that day; full timestamps are kept as given. */
function parseDate(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) s = excelSerialToISODate(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { at: new Date(`${s}T12:00:00+05:30`), precision: "day" };
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // 31/10/2026 (day first, as in India)
  if (m) return { at: new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T12:00:00+05:30`), precision: "day" };
  const d = new Date(s.includes("T") || /[+Z]/.test(s) ? s : `${s.replace(" ", "T")}+05:30`);
  return Number.isNaN(d.getTime()) ? null : { at: d, precision: "second" };
}

function normStatus(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "refunded") return "refunded";
  if (s.startsWith("partial")) return "partially_refunded";
  return "completed";
}

function splitItems(text, count) {
  const t = String(text || "").trim();
  if (!t) return [];
  if (count > 1) {
    const parts = t.split(/\s*[,;|\n]\s*(?=\S)/).filter(Boolean);
    if (parts.length === count) return parts;
  }
  return [t];
}

function rowToEvent(row, get, batchId) {
  const gross = toAmount(get(row, "gross")) ?? 0;
  const couponApplied = yes(get(row, "couponApplied")) || Boolean(get(row, "couponCode"));
  const discount = couponApplied ? toAmount(get(row, "couponDiscount")) ?? 0 : 0;
  const date = parseDate(get(row, "date"));
  const numItems = Number(get(row, "numItems")) || 1;
  const names = splitItems(get(row, "items"), numItems);
  const listAmount = Math.round((gross + discount) * 100) / 100;
  const orderId = get(row, "orderId");

  const payload = { ...row };
  for (const k of Object.keys(payload)) if (DROP_FROM_PAYLOAD.includes(k.toLowerCase())) delete payload[k];

  return {
    source: "import",
    type: "sale",
    quiet: true,
    emailRaw: get(row, "email"),
    firstName: get(row, "firstName"),
    lastName: get(row, "lastName"),
    mobile: get(row, "phone"),
    country: get(row, "country"),
    state: get(row, "state"),
    unsubscribed: yes(get(row, "unsubscribed")),
    unconsented: yes(get(row, "unconsented")),
    sale: {
      orderId,
      currency: normCurrency(get(row, "currency")),
      amountGross: gross,
      amountNet: toAmount(get(row, "net")),
      payhipFee: toAmount(get(row, "payhipFee")),
      gatewayFee: toAmount(get(row, "gatewayFee")),
      listAmount,
      discountAmount: discount,
      couponCode: get(row, "couponCode") || null,
      couponPct: toAmount(get(row, "couponPct")),
      usedCoupon: couponApplied,
      paymentType: get(row, "paymentType").toLowerCase() || null,
      status: normStatus(get(row, "status")),
      country: get(row, "country") || null,
      state: get(row, "state") || null,
      downloads: get(row, "downloads") === "" ? null : Number(get(row, "downloads")),
      orderedAt: date?.at || null,
      datePrecision: date?.precision || "day",
      items: names.map((n) => ({ productName: n, quantity: 1, unitListPrice: names.length === 1 ? listAmount : undefined })),
    },
    dedupeKey: orderId ? `payhip:paid:${orderId}` : null,
    payload,
    importBatchId: batchId,
    occurredAt: date?.at || null,
    _dateOk: Boolean(date),
  };
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main() {
  if (!file) {
    console.log('Usage: npm run import:payhip -- <file.csv|file.xlsx> [--commit] [--force] [--by "Name"]');
    process.exit(1);
  }
  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  const { headers, rows } = readTable(filePath);
  const { get, missing } = getter(headers);
  if (missing.length) throw new Error(`This doesn't look like a Payhip export — missing column(s): ${missing.join(", ")}`);

  console.log(`\nWishtune CRM — Payhip import ${COMMIT ? "(COMMIT)" : "(dry run — nothing will be saved)"}`);
  console.log(`File: ${path.basename(filePath)} · ${rows.length} row(s)\n`);

  if (COMMIT && !FORCE) {
    const [prev] = await db.execute(
      "SELECT id, finished_at FROM import_batches WHERE file_sha256 = ? AND is_dry_run = 0 AND status = 'completed' LIMIT 1",
      [sha],
    );
    if (prev[0]) {
      throw new Error(
        `This exact file was already imported (import #${prev[0].id}). Re-run with --force to import it again (orders are still de-duplicated).`,
      );
    }
  }

  const [batchRes] = await db.execute(
    "INSERT INTO import_batches (source, file_name, file_sha256, is_dry_run, rows_total, run_by) VALUES ('payhip', ?, ?, ?, ?, ?)",
    [path.basename(filePath), sha, COMMIT ? 0 : 1, rows.length, RUN_BY],
  );
  const batchId = batchRes.insertId;

  // Oldest first. Within one day the export lists newest first, so reverse it.
  const ordered = rows
    .map((row, i) => ({ row, i, evt: rowToEvent(row, get, batchId) }))
    .sort((a, b) => (a.evt.occurredAt?.getTime() ?? 0) - (b.evt.occurredAt?.getTime() ?? 0) || b.i - a.i);

  const stats = { created: 0, duplicate: 0, rejected: 0, contactsCreated: 0 };
  const rejected = [];
  const unmapped = new Map();
  const flagged = new Set();
  const conflicts = [];

  const conn = await db.getConnection();
  const rules = await getRules();
  let failed = null;
  try {
    await conn.beginTransaction();
    for (const { evt, i } of ordered) {
      const line = i + 2; // spreadsheet row number (header is row 1)
      if (!evt._dateOk) {
        stats.rejected += 1;
        rejected.push({ line, email: evt.emailRaw, reason: `Unreadable date "${get(rows[i], "date")}"` });
        continue;
      }
      const r = await processEvent(evt, { conn, rules });
      if (r.status === "processed") {
        stats.created += 1;
        if (r.created) stats.contactsCreated += 1;
        for (const u of r.unmapped || []) unmapped.set(u, (unmapped.get(u) || 0) + 1);
        if (r.flaggedAsTest) flagged.add(`${evt.emailRaw.trim().toLowerCase()} (${r.flaggedAsTest})`);
        if (r.mobileConflict) conflicts.push(`row ${line}: ${r.mobileConflict}`);
      } else if (r.status === "duplicate") stats.duplicate += 1;
      else {
        stats.rejected += 1;
        rejected.push({ line, email: evt.emailRaw, reason: r.reason });
      }
    }

    // Snapshot of the touched contacts, for the report.
    const [contacts] = await conn.execute(
      `SELECT c.primary_email, c.stage, c.purchase_count, c.paid_purchase_count, c.is_internal, c.country
       FROM contacts c WHERE c.id IN (SELECT DISTINCT contact_id FROM events WHERE import_batch_id = ? AND contact_id IS NOT NULL)
       ORDER BY c.is_internal, c.paid_purchase_count DESC, c.purchase_count DESC, c.primary_email`,
      [batchId],
    );

    if (COMMIT) await conn.commit();
    else await conn.rollback();

    console.log(`${pad("Email", 38)} ${pad("Stage", 13)} ${pad("Orders", 7)} ${pad("Paid", 5)} Test`);
    console.log("-".repeat(72));
    for (const c of contacts) {
      console.log(
        `${pad(c.primary_email, 38)} ${pad(c.stage, 13)} ${pad(c.purchase_count, 7)} ${pad(c.paid_purchase_count, 5)} ${Number(c.is_internal) ? "test" : ""}`,
      );
    }
    console.log("\nSummary");
    console.log(`  orders imported      ${stats.created}`);
    console.log(`  already in the CRM   ${stats.duplicate}`);
    console.log(`  rejected             ${stats.rejected}`);
    console.log(`  new contacts         ${stats.contactsCreated}`);
    console.log(`  real contacts        ${contacts.filter((c) => !Number(c.is_internal)).length}`);
    console.log(`  test contacts        ${contacts.filter((c) => Number(c.is_internal)).length}`);
    if (rejected.length) {
      console.log("\nRejected rows (fix in the file and re-run — the rest is not affected):");
      for (const r of rejected) console.log(`  row ${r.line}: ${r.email || "(no email)"} — ${r.reason}`);
    }
    if (unmapped.size) {
      console.log("\nProducts not matched to an MT code (map them in Settings → Products):");
      for (const [name, n] of unmapped) console.log(`  ${name} — ${n} order(s)`);
    }
    if (flagged.size) {
      console.log("\nFlagged as test (Settings → Test contacts):");
      for (const f of flagged) console.log(`  ${f}`);
    }
    if (conflicts.length) {
      console.log("\nMobile numbers already on another contact (not moved):");
      for (const c of conflicts) console.log(`  ${c}`);
    }
    console.log(COMMIT ? "\nSaved." : "\nDry run only — nothing was saved. Re-run with --commit to import.");

    await db.execute(
      `UPDATE import_batches SET status = 'completed', rows_created = ?, rows_duplicate = ?, rows_rejected = ?,
         contacts_created = ?, report = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?`,
      [
        stats.created,
        stats.duplicate,
        stats.rejected,
        stats.contactsCreated,
        JSON.stringify({ rejected, unmapped: Object.fromEntries(unmapped), flagged: [...flagged], conflicts }),
        batchId,
      ],
    );
  } catch (err) {
    failed = err;
    await conn.rollback().catch(() => {});
    await db
      .execute("UPDATE import_batches SET status = 'failed', report = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?", [
        JSON.stringify({ error: err.message }),
        batchId,
      ])
      .catch(() => {});
  } finally {
    conn.release();
  }
  if (failed) throw failed;
}

main()
  .catch((err) => {
    console.error(`\nImport stopped, nothing was saved: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end());
