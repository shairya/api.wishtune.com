// lib/sql.js — shared SQL helpers.

function toInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** EXISTS clause: the contact has an order containing a product matching `cond` (aliases o, oi, p). */
const boughtExists = (cond) =>
  `EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
           JOIN products p ON p.id = oi.product_id
           WHERE o.contact_id = c.id AND ${cond})`;

/** Money actually kept, per currency, for one contact (refunds deducted). */
const paidSum = (currency) =>
  `(SELECT COALESCE(SUM(o.amount_gross - COALESCE(o.refunded_amount, 0)), 0)
    FROM orders o WHERE o.contact_id = c.id AND o.currency = '${currency}')`;

/** Products a contact bought: MT codes, or the Payhip name while unmapped. */
const PRODUCTS_SUBQUERY = `(SELECT GROUP_CONCAT(DISTINCT COALESCE(p.product_code, oi.payhip_product_name)
     ORDER BY COALESCE(p.product_code, oi.payhip_product_name) SEPARATOR ', ')
   FROM orders o JOIN order_items oi ON oi.order_id = o.id
   LEFT JOIN products p ON p.id = oi.product_id
   WHERE o.contact_id = c.id)`;

module.exports = { toInt, boughtExists, paidSum, PRODUCTS_SUBQUERY };
