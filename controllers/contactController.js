// controllers/contactController.js — contact list, CSV exports, contact page, edits.

const db = require("../config/mysql");
const { insertEvent } = require("../services/eventLog");
const { attachIdentifier } = require("../services/identityService");
const { normalizeMobile, cleanText } = require("../lib/normalize");
const { toInt, boughtExists, paidSum, PRODUCTS_SUBQUERY } = require("../lib/sql");

const STAGES = ["contact", "subscriber", "customer", "repeat_buyer"];
const FOCUSES = ["love", "beauty", "health", "wealth", "everything"];
const FORMATS = ["shower", "party", "sleep"];
const SOURCES = ["buyer", "signup", "contact_message"];
const SORTS = {
  recent: "c.last_event_at DESC, c.id DESC",
  newest: "c.created_at DESC, c.id DESC",
  last_purchase: "c.last_purchase_at IS NULL, c.last_purchase_at DESC, c.id DESC",
  purchases: "c.purchase_count DESC, c.last_purchase_at DESC",
  email: "c.primary_email ASC",
};

/**
 * WHERE clause from list filters (shared by the list and the exports).
 * Test contacts are hidden unless internal=include|only.
 */
function buildFilters(q) {
  const where = ["c.merged_into_id IS NULL"];
  const params = [];

  if (q.internal === "only") where.push("c.is_internal = 1");
  else if (q.internal !== "include") where.push("c.is_internal = 0");

  const search = cleanText(q.q, 100);
  if (search) {
    where.push(`(c.primary_email LIKE ? OR c.primary_mobile LIKE ? OR CONCAT_WS(' ', c.first_name, c.last_name) LIKE ?
      OR EXISTS (SELECT 1 FROM contact_identifiers ci WHERE ci.contact_id = c.id AND ci.value LIKE ?))`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (STAGES.includes(q.stage)) {
    where.push("c.stage = ?");
    params.push(q.stage);
  }
  if (q.buyer === "paid") where.push("c.paid_purchase_count > 0");
  if (q.buyer === "free_only") where.push("c.purchase_count > 0 AND c.paid_purchase_count = 0");
  if (q.buyer === "any") where.push("c.purchase_count > 0");
  if (q.buyer === "non_buyer") where.push("c.purchase_count = 0");
  if (FOCUSES.includes(q.focus)) {
    // Focus = bought a product with that focus, or signed up on that focus's page.
    where.push(`(${boughtExists("p.focus = ?")} OR c.first_page_seen = ?)`);
    params.push(q.focus, q.focus);
  }
  if (FORMATS.includes(q.format)) {
    where.push(boughtExists("p.format = ?"));
    params.push(q.format);
  }
  if (q.product) {
    where.push(boughtExists("p.product_code = ?"));
    params.push(String(q.product).slice(0, 20));
  }
  if (q.currency && /^[A-Z]{3}$/.test(q.currency)) {
    where.push("EXISTS (SELECT 1 FROM orders o WHERE o.contact_id = c.id AND o.currency = ?)");
    params.push(q.currency);
  }
  if (SOURCES.includes(q.source)) {
    where.push("c.lead_source = ?");
    params.push(q.source);
  }
  if (q.country) {
    where.push("c.country = ?");
    params.push(String(q.country).slice(0, 100));
  }
  if (q.consent === "yes") where.push("c.email_consent = 1");
  if (q.consent === "no") where.push("c.email_consent = 0");
  if (q.consent === "unknown") where.push("c.email_consent IS NULL");
  if (q.unsubscribed === "1") where.push("c.unsubscribed = 1");
  if (q.unsubscribed === "0") where.push("c.unsubscribed = 0");
  if (q.has_mobile === "1") where.push("c.primary_mobile IS NOT NULL");
  if (q.has_mobile === "0") where.push("c.primary_mobile IS NULL");
  if (q.campaign) {
    where.push("c.utm_campaign = ?");
    params.push(String(q.campaign).slice(0, 255));
  }
  return { sql: `WHERE ${where.join(" AND ")}`, params };
}

exports.list = async (req, res) => {
  try {
    const { sql, params } = buildFilters(req.query);
    const pageSize = toInt(req.query.pageSize, 25, { min: 1, max: 100 });
    const page = toInt(req.query.page, 1, { min: 1 });
    const order = SORTS[req.query.sort] || SORTS.recent;

    const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM contacts c ${sql}`, params);
    const [rows] = await db.execute(
      `SELECT c.id, c.primary_email, c.primary_mobile, c.first_name, c.last_name, c.country, c.stage, c.lead_source,
              c.first_page_seen, c.utm_campaign, c.email_consent, c.unsubscribed, c.is_internal,
              c.purchase_count, c.paid_purchase_count, c.last_purchase_at, c.last_event_at, c.created_at,
              ${paidSum("INR")} AS paid_inr, ${paidSum("USD")} AS paid_usd,
              ${PRODUCTS_SUBQUERY} AS products
       FROM contacts c ${sql}
       ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    return res.json({ data: rows, total: Number(total), page, pageSize });
  } catch (err) {
    console.error("[contacts] list failed:", err);
    return res.status(500).json({ error: "Could not load contacts" });
  }
};

function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const istDate = (d) => (d ? new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "");

/**
 * GET /contacts/export.csv?type=…  (+ any list filter)
 *   paid      — paying customers, not unsubscribed      → Meta custom audience
 *   buyers    — every buyer incl. 100%-off, not unsubscribed
 *   exclusion — every buyer, unsubscribed or not        → exclude from prospecting ads
 *   all       — whatever the current filters select
 * Test contacts are always left out of paid/buyers/exclusion.
 * Columns: email, stage, products, last_purchase_date
 */
exports.exportCsv = async (req, res) => {
  try {
    const type = ["paid", "buyers", "exclusion"].includes(req.query.type) ? req.query.type : "all";
    const q = type === "all" ? req.query : { ...req.query, internal: "exclude" };
    const { sql, params } = buildFilters(q);
    const extra = [];
    if (type === "paid") extra.push("c.paid_purchase_count > 0", "c.unsubscribed = 0");
    if (type === "buyers") extra.push("c.purchase_count > 0", "c.unsubscribed = 0");
    if (type === "exclusion") extra.push("c.purchase_count > 0");
    const where = [sql, ...extra.map((e) => `AND ${e}`)].join(" ");

    const [rows] = await db.execute(
      `SELECT c.primary_email AS email, c.stage, c.last_purchase_at, ${PRODUCTS_SUBQUERY} AS products
       FROM contacts c ${where} AND c.primary_email IS NOT NULL
       ORDER BY c.primary_email ASC`,
      params,
    );

    const lines = ["email,stage,products,last_purchase_date"];
    for (const r of rows) {
      lines.push([r.email, r.stage, r.products || "", istDate(r.last_purchase_at)].map(csvCell).join(","));
    }
    await insertEvent({
      source: "admin",
      type: "export",
      summary: `CSV export (${type}) · ${rows.length} rows`,
      details: { type, filters: req.query, rows: rows.length },
      createdBy: req.user?.id,
    }).catch(() => {});
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="wishtune-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return res.send(`${lines.join("\r\n")}\r\n`);
  } catch (err) {
    console.error("[contacts] export failed:", err);
    return res.status(500).json({ error: "Export failed" });
  }
};

exports.get = async (req, res) => {
  const id = toInt(req.params.id, 0);
  try {
    const [contacts] = await db.execute("SELECT * FROM contacts WHERE id = ? LIMIT 1", [id]);
    if (!contacts[0]) return res.status(404).json({ error: "Contact not found" });
    const contact = contacts[0];

    const [identifiers] = await db.execute(
      "SELECT type, value, value_raw, is_primary, source, first_seen_at FROM contact_identifiers WHERE contact_id = ? ORDER BY type, is_primary DESC, first_seen_at",
      [id],
    );
    const [orders] = await db.execute(
      `SELECT id, payhip_order_id, currency, list_amount, discount_amount, amount_gross, amount_net, payhip_fee, coupon_code,
              coupon_pct, used_coupon, is_free, payment_type, status, refunded_amount, refunded_at, country,
              downloads, ordered_at, date_precision, source
       FROM orders WHERE contact_id = ? ORDER BY ordered_at DESC, id DESC`,
      [id],
    );
    const [items] = orders.length
      ? await db.execute(
          `SELECT oi.order_id, oi.payhip_product_name, oi.quantity, oi.unit_list_price,
                  p.product_code, p.name AS product_name, p.format, p.focus
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
           WHERE o.contact_id = ?`,
          [id],
        )
      : [[]];
    for (const o of orders) o.items = items.filter((i) => i.order_id === o.id);

    const [events] = await db.execute(
      `SELECT e.id, e.source, e.type, e.status, e.summary, e.details, e.error, e.stage_before, e.stage_after,
              e.matched_by, e.occurred_at, e.created_at, u.full_name AS created_by_name
       FROM events e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.contact_id = ?
         AND NOT (e.status = 'duplicate' AND e.source = 'import') -- re-imported rows: kept in the event log only
       ORDER BY COALESCE(e.occurred_at, e.created_at) DESC, e.id DESC LIMIT 500`,
      [id],
    );
    const [outreach] = await db.execute(
      "SELECT channel, provider, status, attempts, mobile, last_error, created_at, updated_at FROM bot_outreach WHERE contact_id = ?",
      [id],
    );
    let mergedInto = null;
    if (contact.merged_into_id) {
      const [m] = await db.execute("SELECT id, primary_email FROM contacts WHERE id = ?", [contact.merged_into_id]);
      mergedInto = m[0] || null;
    }
    return res.json({ contact, identifiers, orders, events, outreach, mergedInto });
  } catch (err) {
    console.error("[contacts] get failed:", err);
    return res.status(500).json({ error: "Could not load contact" });
  }
};

/** PATCH /contacts/:id — admin edits: first_name, last_name, mobile, unsubscribed, is_internal. */
exports.update = async (req, res) => {
  const id = toInt(req.params.id, 0);
  const b = req.body || {};
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute("SELECT * FROM contacts WHERE id = ? FOR UPDATE", [id]);
    const c = rows[0];
    if (!c) {
      await conn.rollback();
      return res.status(404).json({ error: "Contact not found" });
    }

    const set = {};
    const changes = [];
    for (const [key, col] of [
      ["first_name", "first_name"],
      ["last_name", "last_name"],
    ]) {
      if (b[key] !== undefined) {
        const v = cleanText(b[key], 120);
        if (v !== c[col]) {
          set[col] = v;
          changes.push(`${key.replace("_", " ")} → ${v || "(cleared)"}`);
        }
      }
    }

    if (b.mobile !== undefined) {
      const raw = cleanText(b.mobile, 40);
      const mobile = raw ? normalizeMobile(raw) : null;
      if (raw && !mobile) {
        await conn.rollback();
        return res.status(400).json({ error: "That does not look like a valid mobile number" });
      }
      if (mobile !== c.primary_mobile) {
        if (mobile) {
          const r = await attachIdentifier(conn, id, { type: "mobile", value: mobile, raw, source: "admin", primary: true });
          if (r.conflictContactId) {
            const [other] = await conn.execute("SELECT primary_email FROM contacts WHERE id = ?", [r.conflictContactId]);
            await conn.rollback();
            return res
              .status(409)
              .json({ error: `${mobile} already belongs to ${other[0]?.primary_email || `contact #${r.conflictContactId}`}` });
          }
          if (r.existing) {
            await conn.execute("UPDATE contact_identifiers SET is_primary = (value = ?) WHERE contact_id = ? AND type = 'mobile'", [
              mobile,
              id,
            ]);
          }
        } else {
          await conn.execute("UPDATE contact_identifiers SET is_primary = 0 WHERE contact_id = ? AND type = 'mobile'", [id]);
        }
        set.primary_mobile = mobile;
        set.mobile_added_at = mobile ? new Date() : null;
        changes.push(`mobile → ${mobile || "(cleared)"}`);
      }
    }

    const flagEvents = [];
    if (b.unsubscribed !== undefined) {
      const v = b.unsubscribed ? 1 : 0;
      if (v !== Number(c.unsubscribed)) {
        set.unsubscribed = v;
        set.unsubscribed_at = v ? new Date() : null;
        flagEvents.push(
          v
            ? ["unsubscribe", "Marked unsubscribed — will not be contacted"]
            : ["resubscribe", "Unsubscribe removed"],
        );
      }
    }
    if (b.is_internal !== undefined) {
      const v = b.is_internal ? 1 : 0;
      if (v !== Number(c.is_internal) || c.internal_reason !== "manual") {
        set.is_internal = v;
        set.internal_reason = "manual";
        flagEvents.push(
          v
            ? ["marked_test", "Marked as test / team contact — hidden from stats and audiences"]
            : ["unmarked_test", "Marked as a real contact (not test)"],
        );
      }
    }

    if (!Object.keys(set).length) {
      await conn.rollback();
      return res.json({ success: true, changed: false });
    }
    const cols = Object.keys(set);
    await conn.execute(`UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
      ...cols.map((k) => set[k]),
      id,
    ]);
    if (changes.length) {
      await insertEvent(
        {
          contactId: id,
          source: "admin",
          type: "contact_updated",
          summary: `Edited: ${changes.join("; ")}`,
          details: { before: { first_name: c.first_name, last_name: c.last_name, mobile: c.primary_mobile }, after: set },
          createdBy: req.user?.id,
        },
        conn,
      );
    }
    for (const [type, summary] of flagEvents) {
      await insertEvent({ contactId: id, source: "admin", type, summary, createdBy: req.user?.id }, conn);
    }
    if (set.unsubscribed === 1 || set.is_internal === 1) {
      await conn.execute(
        "UPDATE bot_outreach SET status = 'skipped', last_error = ? WHERE contact_id = ? AND status = 'queued'",
        [set.unsubscribed === 1 ? "Contact unsubscribed" : "Test contact", id],
      );
    } else if (set.unsubscribed === 0) {
      await conn.execute("DELETE FROM bot_outreach WHERE contact_id = ? AND status = 'skipped'", [id]);
    }
    await conn.commit();
    return res.json({ success: true, changed: true });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error("[contacts] update failed:", err);
    return res.status(500).json({ error: "Could not update contact" });
  } finally {
    conn.release();
  }
};

/** POST /contacts/:id/notes — support history (wishtune.support@gmail.com etc.). */
exports.addNote = async (req, res) => {
  const id = toInt(req.params.id, 0);
  const text = String(req.body?.text || "").trim().slice(0, 5000);
  if (!text) return res.status(400).json({ error: "Note text is required" });
  try {
    const [rows] = await db.execute("SELECT id FROM contacts WHERE id = ?", [id]);
    if (!rows[0]) return res.status(404).json({ error: "Contact not found" });
    const eventId = await insertEvent({
      contactId: id,
      source: "admin",
      type: "note",
      summary: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      details: { text },
      createdBy: req.user?.id,
    });
    return res.status(201).json({ success: true, eventId });
  } catch (err) {
    console.error("[contacts] note failed:", err);
    return res.status(500).json({ error: "Could not save note" });
  }
};

exports.filterOptions = async (_req, res) => {
  try {
    const [products] = await db.execute(
      "SELECT product_code, name, format, focus FROM products WHERE is_active = 1 ORDER BY product_code",
    );
    const [campaigns] = await db.execute(
      "SELECT DISTINCT utm_campaign FROM contacts WHERE utm_campaign IS NOT NULL ORDER BY utm_campaign LIMIT 200",
    );
    const [countries] = await db.execute(
      "SELECT DISTINCT country FROM contacts WHERE country IS NOT NULL ORDER BY country LIMIT 200",
    );
    const [currencies] = await db.execute("SELECT DISTINCT currency FROM orders ORDER BY currency = 'INR' DESC, currency");
    return res.json({
      stages: STAGES,
      focuses: FOCUSES,
      formats: FORMATS,
      sources: SOURCES,
      products,
      campaigns: campaigns.map((c) => c.utm_campaign),
      countries: countries.map((c) => c.country),
      currencies: currencies.map((c) => c.currency),
    });
  } catch (err) {
    console.error("[contacts] options failed:", err);
    return res.status(500).json({ error: "Could not load filter options" });
  }
};
