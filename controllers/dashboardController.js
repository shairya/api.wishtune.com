// controllers/dashboardController.js — headline numbers. Test contacts are excluded.

const db = require("../config/mysql");

const REAL = "c.is_internal = 0 AND c.merged_into_id IS NULL";

exports.summary = async (_req, res) => {
  try {
    const [stages] = await db.execute(`SELECT c.stage, COUNT(*) AS n FROM contacts c WHERE ${REAL} GROUP BY c.stage`);
    const [[totals]] = await db.execute(
      `SELECT COUNT(*) AS contacts,
              SUM(c.purchase_count > 0) AS buyers,
              SUM(c.paid_purchase_count > 0) AS paid_buyers,
              SUM(c.unsubscribed = 1) AS unsubscribed,
              SUM(c.primary_mobile IS NOT NULL) AS with_mobile,
              SUM(c.email_consent = 1) AS consented
       FROM contacts c WHERE ${REAL}`,
    );
    const [[tests]] = await db.execute("SELECT COUNT(*) AS n FROM contacts WHERE is_internal = 1 AND merged_into_id IS NULL");
    // Revenue per currency (INR first). Free orders are counted as orders but add nothing.
    const [revenue] = await db.execute(
      `SELECT o.currency, COUNT(*) AS orders, SUM(o.is_free = 0) AS paid_orders,
              COALESCE(SUM(o.amount_gross), 0) AS gross, COALESCE(SUM(o.refunded_amount), 0) AS refunded
       FROM orders o JOIN contacts c ON c.id = o.contact_id
       WHERE ${REAL}
       GROUP BY o.currency ORDER BY o.currency = 'INR' DESC, o.currency`,
    );
    const [[week]] = await db.execute(
      `SELECT
         SUM(e.status = 'processed' AND e.type = 'sale' AND e.source = 'payhip') AS sales,
         SUM(e.status = 'processed' AND e.type = 'signup') AS signups,
         SUM(e.status = 'processed' AND e.type = 'contact_message') AS messages,
         SUM(e.status = 'rejected') AS rejected,
         SUM(e.status = 'duplicate') AS duplicates
       FROM events e LEFT JOIN contacts c ON c.id = e.contact_id
       WHERE e.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) AND (c.id IS NULL OR c.is_internal = 0)`,
    );
    const [byFocus] = await db.execute(
      `SELECT p.focus, COUNT(DISTINCT o.contact_id) AS buyers, COUNT(DISTINCT CASE WHEN o.is_free = 0 THEN o.contact_id END) AS paid_buyers
       FROM orders o JOIN contacts c ON c.id = o.contact_id
       JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
       WHERE ${REAL} GROUP BY p.focus ORDER BY buyers DESC`,
    );
    const [byFormat] = await db.execute(
      `SELECT p.format, COUNT(DISTINCT o.id) AS orders
       FROM orders o JOIN contacts c ON c.id = o.contact_id
       JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
       WHERE ${REAL} GROUP BY p.format ORDER BY orders DESC`,
    );
    const [byCampaign] = await db.execute(
      `SELECT COALESCE(c.utm_campaign, '(none)') AS campaign, COUNT(*) AS contacts, SUM(c.paid_purchase_count > 0) AS paid_buyers
       FROM contacts c WHERE ${REAL} GROUP BY COALESCE(c.utm_campaign, '(none)') ORDER BY contacts DESC LIMIT 8`,
    );
    const [[unmapped]] = await db.execute("SELECT COUNT(DISTINCT COALESCE(payhip_product_name, payhip_product_key)) AS n FROM order_items WHERE product_id IS NULL");
    const [recent] = await db.execute(
      `SELECT e.id, e.contact_id, c.primary_email AS contact_email, e.email_raw, e.source, e.type, e.status,
              e.summary, e.error, e.created_at
       FROM events e LEFT JOIN contacts c ON c.id = e.contact_id
       WHERE e.source IN ('payhip','signup','contact_form') AND (c.id IS NULL OR c.is_internal = 0)
       ORDER BY e.created_at DESC, e.id DESC LIMIT 10`,
    );

    const num = (v) => Number(v || 0);
    return res.json({
      stages: Object.fromEntries(
        ["contact", "subscriber", "customer", "repeat_buyer"].map((s) => [s, num(stages.find((r) => r.stage === s)?.n)]),
      ),
      totals: {
        contacts: num(totals.contacts),
        buyers: num(totals.buyers),
        paidBuyers: num(totals.paid_buyers),
        unsubscribed: num(totals.unsubscribed),
        withMobile: num(totals.with_mobile),
        consented: num(totals.consented),
        testContacts: num(tests.n),
      },
      revenue: revenue.map((r) => ({
        currency: r.currency,
        orders: num(r.orders),
        paidOrders: num(r.paid_orders),
        gross: num(r.gross),
        refunded: num(r.refunded),
        net: num(r.gross) - num(r.refunded),
      })),
      last7Days: {
        sales: num(week.sales),
        signups: num(week.signups),
        messages: num(week.messages),
        rejected: num(week.rejected),
        duplicates: num(week.duplicates),
      },
      byFocus: byFocus.map((r) => ({ focus: r.focus, buyers: num(r.buyers), paidBuyers: num(r.paid_buyers) })),
      byFormat: byFormat.map((r) => ({ format: r.format, orders: num(r.orders) })),
      byCampaign: byCampaign.map((r) => ({ campaign: r.campaign, contacts: num(r.contacts), paidBuyers: num(r.paid_buyers) })),
      unmappedProducts: num(unmapped.n),
      recent,
    });
  } catch (err) {
    console.error("[dashboard] summary failed:", err);
    return res.status(500).json({ error: "Could not load dashboard" });
  }
};
