/**
 * services/payhipParser.js — turns a Payhip webhook body into our event shape.
 *
 * Payhip's documented "paid" payload (help.payhip.com/article/115-webhooks):
 *   id, email, currency, price (smallest unit: paise), vat_applied, ip_address,
 *   items[] { product_id, product_name, product_key, product_permalink,
 *             quantity, on_sale, used_coupon, ... },
 *   payment_type, stripe_fee, payhip_fee, unconsented_from_emails, is_gift,
 *   date (unix seconds), type: "paid", signature
 * "refunded" adds amount_refunded, date_refunded, date_created.
 *
 * Payhip does not document a coupon-code field, a buyer name or a phone in
 * this payload. We read the likely field names if they ever appear; otherwise
 * the order is stored with used_coupon = yes and no code. Amounts arrive in
 * the smallest unit and are converted to currency units (₹1999 = 1999).
 */

const { parseBool, cleanText } = require("../lib/normalize");
const { fromMinorUnits, normCurrency } = require("../lib/money");

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function unixToDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}

function normalizeItems(items) {
  const list = Array.isArray(items) ? items : items && typeof items === "object" ? Object.values(items) : [];
  return list.map((i) => ({
    productId: cleanText(i.product_id, 100),
    productKey: cleanText(i.product_key, 100),
    permalink: cleanText(i.product_permalink, 255),
    productName: cleanText(i.product_name, 255),
    quantity: Number(i.quantity) || 1,
    usedCoupon: parseBool(i.used_coupon),
    couponCode: cleanText(firstNonEmpty(i.coupon_code, i.coupon, i.discount_code), 100),
  }));
}

function parsePayhip(body) {
  const b = body || {};
  const items = normalizeItems(b.items);
  const fullName = [b.first_name || b.customer_first_name, b.last_name || b.customer_last_name]
    .filter(Boolean)
    .join(" ");

  return {
    type: String(b.type || "").toLowerCase(),
    orderId: cleanText(firstNonEmpty(b.id, b.transaction_id, b.order_id), 100),
    email: firstNonEmpty(b.email, b.customer_email),
    name: firstNonEmpty(b.customer_name, b.name, fullName),
    firstName: firstNonEmpty(b.first_name, b.customer_first_name),
    lastName: firstNonEmpty(b.last_name, b.customer_last_name),
    mobile: firstNonEmpty(b.phone, b.phone_number, b.customer_phone, b.mobile),
    currency: normCurrency(b.currency),
    amountGross: fromMinorUnits(b.price) || 0, // Payhip sends paise/cents
    discountCode: cleanText(
      firstNonEmpty(b.coupon_code, b.discount_code, b.coupon, ...items.map((i) => i.couponCode)),
      100,
    ),
    usedCoupon: items.some((i) => i.usedCoupon) || parseBool(b.used_coupon),
    paymentType: cleanText(b.payment_type, 30),
    payhipFee: b.payhip_fee !== undefined ? fromMinorUnits(b.payhip_fee) : null,
    gatewayFee: b.stripe_fee !== undefined ? fromMinorUnits(b.stripe_fee) : null,
    paidAt: unixToDate(b.date),
    unconsentedFromEmails: b.unconsented_from_emails === undefined ? undefined : parseBool(b.unconsented_from_emails),
    isGift: b.is_gift === undefined ? undefined : parseBool(b.is_gift),
    amountRefunded: fromMinorUnits(b.amount_refunded) || 0,
    refundedAt: unixToDate(b.date_refunded),
    items: items.map(({ couponCode, ...rest }) => rest),
  };
}

module.exports = { parsePayhip };
