/**
 * services/contactEventService.js
 *
 * The single path every Payhip sale (webhook or import), website sign-up
 * and contact message goes through. Implements the spec's 7 steps:
 *
 *  1. An event arrives.
 *  2. Missing or invalid email → rejected and logged (events.status
 *     'rejected'); no contact is created.
 *  3. Email trimmed + lowercased, looked up in contact_identifiers; update
 *     or create.
 *  4. Details added. A filled field is never blanked. First page seen,
 *     lead source and UTM tags are first-seen-only.
 *  5. Paid sale → stage Customer, purchase count +1; 2+ → Repeat buyer.
 *     (100%-off orders count for the stage; paid_purchase_count only counts
 *     orders where money was paid.)
 *  6. Not a sale → stage kept; a stage never moves backward. A sign-up lifts
 *     a Contact to Subscriber.
 *  7. Saved and logged. The Payhip order ID is unique (shared by webhook and
 *     import), so a repeated order is logged as 'duplicate' and not counted.
 *
 * Pass { conn } to run inside a caller's transaction (the importer does, so
 * a dry run can roll everything back). Without it, each event is its own
 * transaction.
 */

const db = require("../config/mysql");
const { insertEvent } = require("./eventLog");
const { findContact, attachIdentifier, createContact } = require("./identityService");
const { matchProduct, listPrice } = require("./productMatcher");
const { getRules, matchRules } = require("./internalService");
const { normalizeEmail, normalizeMobile, cleanText, cleanPage } = require("../lib/normalize");
const { formatAmount, normCurrency } = require("../lib/money");

const STAGE_RANK = { contact: 1, subscriber: 2, customer: 3, repeat_buyer: 4 };
const INITIAL_STAGE = { sale: "customer", signup: "subscriber", contact_message: "contact" };
const LEAD_SOURCE = { sale: "buyer", signup: "signup", contact_message: "contact_message" };

const maxStage = (a, b) => (STAGE_RANK[a] >= STAGE_RANK[b] ? a : b);

function splitName(full) {
  const s = cleanText(full, 240);
  if (!s) return { first: null, last: null };
  const i = s.indexOf(" ");
  return i === -1 ? { first: s, last: null } : { first: s.slice(0, i), last: s.slice(i + 1) };
}

function buildSummary(evt, page) {
  if (evt.type === "sale") {
    const s = evt.sale;
    const names = (s.items || []).map((i) => i.productName || i.productKey || i.productId).filter(Boolean);
    const parts = [`${evt.source === "import" ? "Imported sale" : "Payhip sale"}${names.length ? `: ${names.join(", ")}` : ""}`];
    parts.push(Number(s.amountGross) > 0 ? formatAmount(s.amountGross, s.currency) : "free");
    if (s.couponCode) parts.push(`code ${s.couponCode}`);
    else if (s.usedCoupon) parts.push("coupon used");
    if (s.status && s.status !== "completed") parts.push(s.status.replace("_", " "));
    return parts.join(" · ");
  }
  if (evt.type === "signup") return `Signed up${page ? ` on ${page}` : ""} · consent ${evt.consent ? "yes" : "no"}`;
  if (evt.type === "contact_message") {
    const msg = cleanText(evt.message, 120);
    return `Contact message${msg ? `: "${msg}"` : ""}`;
  }
  return evt.type;
}

async function recordRejected(evt, reason, conn) {
  if (!evt.quiet) console.warn(`[events] rejected ${evt.source}/${evt.type}: ${reason}`);
  const eventId = await insertEvent(
    {
      source: evt.source,
      type: evt.type,
      status: "rejected",
      emailRaw: evt.emailRaw,
      summary: `Rejected ${evt.type.replace("_", " ")}${evt.sale?.orderId ? ` (order ${evt.sale.orderId})` : ""}`,
      error: reason,
      payload: evt.payload,
      importBatchId: evt.importBatchId,
      occurredAt: evt.occurredAt || null,
    },
    conn,
  );
  return { status: "rejected", reason, eventId };
}

async function recordDuplicate(evt, email, contactId, conn) {
  const eventId = await insertEvent(
    {
      contactId: contactId || null,
      source: evt.source,
      type: evt.type,
      status: "duplicate",
      emailRaw: email,
      summary: `Duplicate ignored (${evt.dedupeKey})`,
      error: "Already in the CRM — not counted again",
      payload: evt.payload,
      importBatchId: evt.importBatchId,
      occurredAt: evt.occurredAt || null,
    },
    conn,
  );
  return { status: "duplicate", contactId: contactId || null, eventId };
}

async function insertOrder(conn, contact, evt, now) {
  const s = evt.sale;
  const currency = normCurrency(s.currency);
  const gross = Number(s.amountGross) || 0;

  // Link items to products and work out the list price when not given.
  const items = [];
  let listFromProducts = 0;
  let listKnown = true;
  for (const item of s.items || []) {
    const product = await matchProduct(conn, item);
    const unit = item.unitListPrice ?? (product ? await listPrice(conn, product.id, currency) : null);
    if (unit === null || unit === undefined) listKnown = false;
    else listFromProducts += Number(unit) * (Number(item.quantity) || 1);
    items.push({ ...item, product, unit });
  }
  const listAmount = s.listAmount ?? (items.length && listKnown ? listFromProducts : null);
  const discount = s.discountAmount ?? (listAmount !== null && listAmount > gross ? listAmount - gross : 0);
  const status = s.status || "completed";
  const refunded = status === "refunded" ? s.refundedAmount ?? gross : s.refundedAmount ?? null;

  const [res] = await conn.execute(
    `INSERT INTO orders
       (payhip_order_id, contact_id, currency, list_amount, discount_amount, amount_gross, amount_net,
        payhip_fee, gateway_fee, coupon_code, coupon_pct, used_coupon, is_free, payment_type, status,
        refunded_amount, refunded_at, country, state, downloads, ordered_at, date_precision, source, import_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(s.orderId),
      contact.id,
      currency,
      listAmount,
      discount || 0,
      gross,
      s.amountNet ?? null,
      s.payhipFee ?? null,
      s.gatewayFee ?? null,
      s.couponCode || null,
      s.couponPct ?? null,
      s.usedCoupon || s.couponCode ? 1 : 0,
      gross <= 0 ? 1 : 0,
      s.paymentType || (gross <= 0 ? "free" : null),
      status,
      refunded,
      refunded !== null && refunded !== undefined ? s.refundedAt || s.orderedAt || now : null,
      s.country || null,
      s.state || null,
      s.downloads ?? null,
      s.orderedAt || now,
      s.datePrecision || "second",
      evt.source === "import" ? "import" : "webhook",
      evt.importBatchId || null,
    ],
  );
  for (const i of items) {
    await conn.execute(
      `INSERT INTO order_items
         (order_id, product_id, payhip_product_name, payhip_product_id, payhip_product_key, payhip_permalink,
          quantity, unit_list_price, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        res.insertId,
        i.product?.id || null,
        cleanText(i.productName, 255),
        cleanText(i.productId, 100),
        cleanText(i.productKey, 100),
        cleanText(i.permalink, 255),
        Number(i.quantity) || 1,
        i.unit ?? null,
        currency,
      ],
    );
  }
  return {
    orderDbId: res.insertId,
    isPaid: gross > 0 && status !== "refunded",
    unmapped: items.filter((i) => !i.product).map((i) => i.productName || i.productKey || "?"),
    products: items.filter((i) => i.product).map((i) => i.product.product_code),
  };
}

/**
 * @param {object} evt   see file header; sale fields are in currency units (₹1999 = 1999)
 * @param {{conn?: import('mysql2/promise').PoolConnection}} [opts]
 */
async function processEvent(evt, opts = {}) {
  const external = opts.conn || null;
  const conn = external || (await db.getConnection());

  // Step 2: validate
  const checked = normalizeEmail(evt.emailRaw);
  if (!checked.ok) {
    if (!external) conn.release();
    return recordRejected(evt, checked.reason, external || db);
  }
  if (evt.type === "sale" && !evt.sale?.orderId) {
    if (!external) conn.release();
    return recordRejected(evt, "Payhip sale has no order ID", external || db);
  }
  const email = checked.email;

  const now = new Date();
  const isImport = evt.source === "import";
  const when = evt.occurredAt || now;
  const names =
    evt.firstName || evt.lastName
      ? { first: cleanText(evt.firstName, 120), last: cleanText(evt.lastName, 120) }
      : splitName(evt.name);
  const mobileRaw = cleanText(evt.mobile, 40);
  const mobile = normalizeMobile(mobileRaw);
  const page = cleanPage(evt.page);
  const utm = {
    source: cleanText(evt.utm?.source, 255),
    medium: cleanText(evt.utm?.medium, 255),
    campaign: cleanText(evt.utm?.campaign, 255),
  };

  try {
    if (!external) await conn.beginTransaction();

    // Step 7 (idempotency)
    if (evt.dedupeKey) {
      const [seen] = await conn.execute("SELECT id, contact_id FROM events WHERE dedupe_key = ? LIMIT 1", [evt.dedupeKey]);
      let dupContact = seen[0]?.contact_id;
      let isDup = Boolean(seen[0]);
      if (!isDup && evt.type === "sale") {
        const [o] = await conn.execute("SELECT contact_id FROM orders WHERE payhip_order_id = ? LIMIT 1", [String(evt.sale.orderId)]);
        if (o[0]) {
          isDup = true;
          dupContact = o[0].contact_id;
        }
      }
      if (isDup) {
        if (!external) await conn.rollback();
        return recordDuplicate(evt, email, dupContact, external || db);
      }
    }

    // Step 3: find or create
    let found = await findContact(conn, { email, mobile });
    let created = false;
    if (!found) {
      const c = await createContact(conn, {
        email,
        emailRaw: evt.emailRaw,
        stage: INITIAL_STAGE[evt.type],
        leadSource: LEAD_SOURCE[evt.type],
        source: evt.source,
        createdAt: isImport ? when : now,
      });
      if (c) {
        found = { contact: c, matchedBy: "email" };
        created = true;
      } else {
        found = await findContact(conn, { email, mobile });
      }
    }
    const { contact, matchedBy } = found;
    const stageBefore = created ? null : contact.stage;

    // Step 4: add details. Live events: newest value wins. Imports (older
    // data) only fill empty fields.
    const set = {};
    const fill = (col, value) => {
      if (!value || value === contact[col]) return;
      if (!contact[col] || !isImport) set[col] = value;
    };
    fill("first_name", names.first);
    fill("last_name", names.last);
    fill("country", cleanText(evt.country || evt.sale?.country, 100));
    fill("state", cleanText(evt.state || evt.sale?.state, 100));
    if (isImport && when < contact.created_at) set.created_at = when;

    const notes = {};
    if (mobile) {
      const r = await attachIdentifier(conn, contact.id, {
        type: "mobile",
        value: mobile,
        raw: mobileRaw,
        source: evt.source,
        primary: !contact.primary_mobile || !isImport,
      });
      if (r.conflictContactId) {
        notes.mobileConflict = `Mobile ${mobile} already belongs to contact #${r.conflictContactId} — not moved`;
      } else if (mobile !== contact.primary_mobile && (!contact.primary_mobile || !isImport)) {
        set.primary_mobile = mobile;
        set.mobile_added_at = now;
      }
    } else if (mobileRaw) {
      notes.mobileIgnored = `"${mobileRaw}" is not a valid mobile number`;
    }

    if (page && !contact.first_page_seen) set.first_page_seen = page;
    const hasUtm = utm.source || utm.medium || utm.campaign;
    const utmUnset = !contact.utm_source && !contact.utm_medium && !contact.utm_campaign;
    if (hasUtm && utmUnset) {
      set.utm_source = utm.source;
      set.utm_medium = utm.medium;
      set.utm_campaign = utm.campaign;
    } else if (evt.type === "sale" && !contact.utm_campaign && !hasUtm) {
      set.utm_campaign = "unknown"; // Payhip carries no UTM tags and there was no earlier sign-up
    }

    if (evt.type === "signup") {
      set.email_consent = evt.consent ? 1 : 0;
      set.email_consent_at = now;
    }
    if (evt.unconsented && contact.email_consent === null) {
      set.email_consent = 0;
      set.email_consent_at = when;
    }
    if (evt.unsubscribed && !Number(contact.unsubscribed)) {
      set.unsubscribed = 1;
      set.unsubscribed_at = when;
    }

    // Team / test contact?
    const rules = opts.rules || (await getRules());
    const internalHit = matchRules(rules, { email, couponCode: evt.sale?.couponCode });
    if (internalHit && !Number(contact.is_internal) && contact.internal_reason !== "manual") {
      set.is_internal = 1;
      set.internal_reason = "rule";
      notes.flaggedAsTest = internalHit;
    }

    // Step 5 / 6: stage
    let stageAfter = contact.stage;
    let order = null;
    if (evt.type === "sale") {
      order = await insertOrder(conn, contact, evt, now);
      const s = evt.sale;
      const at = s.orderedAt || now;
      const purchaseCount = Number(contact.purchase_count) + 1;
      set.purchase_count = purchaseCount;
      if (order.isPaid) {
        set.paid_purchase_count = Number(contact.paid_purchase_count) + 1;
        if (!contact.last_paid_purchase_at || at > contact.last_paid_purchase_at) set.last_paid_purchase_at = at;
      }
      if (s.couponCode && (!contact.last_purchase_at || at >= contact.last_purchase_at)) set.last_coupon_code = s.couponCode;
      if (!contact.first_purchase_at || at < contact.first_purchase_at) set.first_purchase_at = at;
      if (!contact.last_purchase_at || at > contact.last_purchase_at) set.last_purchase_at = at;
      stageAfter = maxStage(contact.stage, purchaseCount >= 2 ? "repeat_buyer" : "customer");
    } else if (evt.type === "signup") {
      stageAfter = maxStage(contact.stage, "subscriber");
    }
    if (stageAfter !== contact.stage) set.stage = stageAfter;
    if (!contact.last_event_at || when > contact.last_event_at || !isImport) {
      set.last_event_at = isImport ? when : now;
    }

    const cols = Object.keys(set);
    if (cols.length) {
      await conn.execute(`UPDATE contacts SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [
        ...cols.map((c) => set[c]),
        contact.id,
      ]);
    }

    const eventId = await insertEvent(
      {
        contactId: contact.id,
        source: evt.source,
        type: evt.type,
        status: "processed",
        dedupeKey: evt.dedupeKey || null,
        matchedBy: created ? null : matchedBy,
        emailRaw: evt.emailRaw,
        summary: buildSummary(evt, page),
        details: {
          email,
          firstName: names.first,
          lastName: names.last,
          mobile,
          page,
          utm: hasUtm ? utm : undefined,
          consent: evt.type === "signup" ? Boolean(evt.consent) : undefined,
          message: evt.type === "contact_message" ? cleanText(evt.message, 5000) : undefined,
          sale: evt.type === "sale" ? { ...evt.sale, products: order.products, unmapped: order.unmapped } : undefined,
          contactCreated: created,
          ...notes,
          ...(evt.extra || {}),
        },
        payload: evt.payload,
        stageBefore,
        stageAfter,
        importBatchId: evt.importBatchId,
        occurredAt: evt.occurredAt || null,
      },
      conn,
    );
    if (order) await conn.execute("UPDATE orders SET event_id = ? WHERE id = ?", [eventId, order.orderDbId]);

    if (!external) await conn.commit();
    return {
      status: "processed",
      contactId: contact.id,
      created,
      stageBefore,
      stageAfter,
      eventId,
      unmapped: order?.unmapped || [],
      ...notes,
    };
  } catch (err) {
    if (external) throw err;
    await conn.rollback().catch(() => {});
    // Two copies of the same Payhip webhook racing: the loser is a duplicate, not an error.
    if (evt.dedupeKey) {
      const [seen] = await db.execute("SELECT contact_id FROM events WHERE dedupe_key = ? LIMIT 1", [evt.dedupeKey]);
      if (seen[0] || err.code === "ER_DUP_ENTRY") return recordDuplicate(evt, email, seen[0]?.contact_id, db);
    }
    throw err;
  } finally {
    if (!external) conn.release();
  }
}

/**
 * Payhip "refunded" webhook: order marked (partially) refunded. Stage and
 * purchase count stay; a full refund removes the order from the paid count.
 */
async function processRefund({ emailRaw, orderId, amountRefunded, refundedAt, payload, dedupeKey }) {
  const evt = { source: "payhip", type: "refund", emailRaw, payload, dedupeKey };
  const checked = normalizeEmail(emailRaw);
  const email = checked.ok ? checked.email : null;

  const [seen] = await db.execute("SELECT contact_id FROM events WHERE dedupe_key = ? LIMIT 1", [dedupeKey]);
  if (seen[0]) return recordDuplicate(evt, email, seen[0].contact_id, db);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.execute(
      "SELECT id, contact_id, amount_gross, currency, status FROM orders WHERE payhip_order_id = ? LIMIT 1 FOR UPDATE",
      [String(orderId || "")],
    );
    const o = orders[0];
    let contactId = o?.contact_id || null;
    if (!contactId && email) {
      const [c] = await conn.execute("SELECT contact_id FROM contact_identifiers WHERE type = 'email' AND value = ? LIMIT 1", [email]);
      contactId = c[0]?.contact_id || null;
    }
    if (o) {
      const full = Number(amountRefunded) >= Number(o.amount_gross);
      await conn.execute("UPDATE orders SET refunded_amount = ?, refunded_at = ?, status = ? WHERE id = ?", [
        amountRefunded,
        refundedAt || new Date(),
        full ? "refunded" : "partially_refunded",
        o.id,
      ]);
      if (full && Number(o.amount_gross) > 0 && o.status !== "refunded") {
        await conn.execute(
          "UPDATE contacts SET paid_purchase_count = GREATEST(paid_purchase_count - 1, 0) WHERE id = ?",
          [o.contact_id],
        );
      }
    }
    const eventId = await insertEvent(
      {
        contactId,
        source: "payhip",
        type: "refund",
        status: o ? "processed" : "ignored",
        dedupeKey,
        emailRaw,
        summary: `Payhip refund · ${formatAmount(amountRefunded, o?.currency || "INR")} · order ${orderId}`,
        details: { orderId, amountRefunded, email },
        error: o ? null : "No matching order in the CRM",
        payload,
        occurredAt: refundedAt || null,
      },
      conn,
    );
    await conn.commit();
    return { status: o ? "processed" : "ignored", contactId, eventId };
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === "ER_DUP_ENTRY") return recordDuplicate(evt, email, null, db);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { processEvent, processRefund, STAGE_RANK };
