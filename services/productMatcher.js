/**
 * services/productMatcher.js — links a Payhip order item to one of the
 * MT-001..MT-015 products.
 *
 * Tried in order: Payhip product key → product ID → permalink → exact
 * product name ("Party Mixtape — Wealth", dash/case/space-insensitive) →
 * format + focus words found in the name. Unmatched items keep product_id
 * NULL and are listed under Settings → Products until mapped.
 */

const FORMATS = ["shower", "party", "sleep"];
const FOCUSES = ["love", "beauty", "health", "wealth", "everything"];

/** "Party Mixtape — Wealth" / "party mixtape-wealth" → "party mixtape - wealth" */
function nameKey(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/[‐-―−]/g, "-") // en/em dashes, minus → hyphen
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

function parseFormatFocus(name) {
  const s = String(name || "").toLowerCase();
  const format = FORMATS.find((f) => new RegExp(`\\b${f}\\b`).test(s));
  const focus = FOCUSES.find((f) => new RegExp(`\\b${f}\\b`).test(s));
  return format && focus ? { format, focus } : null;
}

/**
 * @param {import('mysql2/promise').Connection} conn
 * @param {{productKey?:string, productId?:string, permalink?:string, productName?:string}} item
 * @returns {Promise<{id:number, product_code:string, format:string, focus:string}|null>}
 */
async function matchProduct(conn, item) {
  const tries = [
    ["payhip_product_key", item.productKey],
    ["payhip_product_id", item.productId],
    ["payhip_permalink", item.permalink],
    ["name_key", nameKey(item.productName)],
  ];
  for (const [col, val] of tries) {
    if (!val) continue;
    const [rows] = await conn.execute(
      `SELECT id, product_code, format, focus FROM products WHERE ${col} = ? LIMIT 1`,
      [val],
    );
    if (rows[0]) return rows[0];
  }
  const ff = parseFormatFocus(item.productName);
  if (ff) {
    const [rows] = await conn.execute(
      "SELECT id, product_code, format, focus FROM products WHERE format = ? AND focus = ? LIMIT 1",
      [ff.format, ff.focus],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

/** List price of a product in a currency (null if not set). */
async function listPrice(conn, productId, currency) {
  if (!productId) return null;
  const [rows] = await conn.execute("SELECT price FROM product_prices WHERE product_id = ? AND currency = ?", [
    productId,
    currency,
  ]);
  return rows[0] ? Number(rows[0].price) : null;
}

/** After a product is edited: link any still-unmapped order items that now match it. */
async function backfillUnmapped(conn) {
  const [items] = await conn.execute(
    "SELECT id, payhip_product_key, payhip_product_id, payhip_permalink, payhip_product_name FROM order_items WHERE product_id IS NULL",
  );
  let linked = 0;
  for (const i of items) {
    const p = await matchProduct(conn, {
      productKey: i.payhip_product_key,
      productId: i.payhip_product_id,
      permalink: i.payhip_permalink,
      productName: i.payhip_product_name,
    });
    if (p) {
      await conn.execute("UPDATE order_items SET product_id = ? WHERE id = ?", [p.id, i.id]);
      linked += 1;
    }
  }
  return linked;
}

module.exports = { FORMATS, FOCUSES, nameKey, parseFormatFocus, matchProduct, listPrice, backfillUnmapped };
