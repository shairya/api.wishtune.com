// controllers/productController.js — the MT-001..MT-015 table (Settings → Products).

const db = require("../config/mysql");
const { insertEvent } = require("../services/eventLog");
const { nameKey, backfillUnmapped, FORMATS, FOCUSES } = require("../services/productMatcher");
const { cleanText } = require("../lib/normalize");
const { toAmount } = require("../lib/money");
const { toInt } = require("../lib/sql");

function readBody(b) {
  const errors = [];
  const code = cleanText(b.product_code, 20);
  if (!code) errors.push("Product code is required (e.g. MT-001)");
  const format = String(b.format || "").toLowerCase();
  if (!FORMATS.includes(format)) errors.push(`Format must be one of ${FORMATS.join(", ")}`);
  const focus = String(b.focus || "").toLowerCase();
  if (!FOCUSES.includes(focus)) errors.push(`Focus must be one of ${FOCUSES.join(", ")}`);
  const name = cleanText(b.name, 255);
  if (!name) errors.push("Name is required (as shown on Payhip, e.g. Shower Mixtape — Love)");

  const prices = {};
  for (const [cur, raw] of Object.entries(b.prices || {})) {
    if (!/^[A-Z]{3}$/.test(cur)) continue;
    if (raw === "" || raw === null || raw === undefined) {
      prices[cur] = null; // remove
      continue;
    }
    const v = toAmount(raw);
    if (v === null || v < 0) errors.push(`${cur} price must be a number`);
    else prices[cur] = v;
  }
  return {
    errors,
    prices,
    values: {
      product_code: code ? code.toUpperCase() : null,
      format,
      focus,
      name,
      name_key: nameKey(name),
      payhip_product_key: cleanText(b.payhip_product_key, 100),
      payhip_product_id: cleanText(b.payhip_product_id, 100),
      payhip_permalink: cleanText(b.payhip_permalink, 255),
      is_active: b.is_active === undefined ? 1 : b.is_active ? 1 : 0,
    },
  };
}

function dupMessage(err) {
  const m = String(err.sqlMessage || err.message || "");
  if (m.includes("uq_products_code")) return "Another product already uses this product code";
  if (m.includes("uq_products_format_focus")) return "Another product already has this format + focus";
  if (m.includes("uq_products_name_key")) return "Another product already has this name";
  if (m.includes("uq_products_key")) return "Another product already uses this Payhip product key";
  if (m.includes("uq_products_pid")) return "Another product already uses this Payhip product ID";
  if (m.includes("uq_products_permalink")) return "Another product already uses this Payhip permalink";
  return "That code, format + focus, name or Payhip identifier is already used by another product";
}

async function loadPrices(ids) {
  if (!ids.length) return {};
  const [rows] = await db.query("SELECT product_id, currency, price FROM product_prices WHERE product_id IN (?)", [ids]);
  const out = {};
  for (const r of rows) (out[r.product_id] ||= {})[r.currency] = Number(r.price);
  return out;
}

exports.list = async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT p.*,
         (SELECT COUNT(DISTINCT oi.order_id) FROM order_items oi WHERE oi.product_id = p.id) AS sales_count
       FROM products p ORDER BY p.product_code`,
    );
    const prices = await loadPrices(rows.map((r) => r.id));
    for (const r of rows) r.prices = prices[r.id] || {};
    return res.json({ data: rows, formats: FORMATS, focuses: FOCUSES });
  } catch (err) {
    console.error("[products] list failed:", err);
    return res.status(500).json({ error: "Could not load products" });
  }
};

/** Payhip items in orders that no product matched. */
exports.unmapped = async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT oi.payhip_product_name, oi.payhip_product_key, oi.payhip_product_id, oi.payhip_permalink,
              COUNT(DISTINCT oi.order_id) AS sales_count
       FROM order_items oi WHERE oi.product_id IS NULL
       GROUP BY oi.payhip_product_name, oi.payhip_product_key, oi.payhip_product_id, oi.payhip_permalink
       ORDER BY sales_count DESC`,
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error("[products] unmapped failed:", err);
    return res.status(500).json({ error: "Could not load unmapped products" });
  }
};

async function save(req, res, id) {
  const { errors, values, prices } = readBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(". ") });
  const cols = Object.keys(values);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    if (id) {
      const [r] = await conn.execute(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [
        ...cols.map((c) => values[c]),
        id,
      ]);
      if (!r.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: "Product not found" });
      }
    } else {
      const [r] = await conn.execute(
        `INSERT INTO products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => values[c]),
      );
      id = r.insertId;
    }
    for (const [cur, price] of Object.entries(prices)) {
      if (price === null) await conn.execute("DELETE FROM product_prices WHERE product_id = ? AND currency = ?", [id, cur]);
      else {
        await conn.execute(
          `INSERT INTO product_prices (product_id, currency, price) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE price = VALUES(price)`,
          [id, cur, price],
        );
      }
    }
    const linked = await backfillUnmapped(conn);
    await insertEvent(
      {
        source: "admin",
        type: "product_saved",
        summary: `Product ${values.product_code} saved${linked ? ` · ${linked} earlier sale item(s) linked` : ""}`,
        details: { ...values, prices },
        createdBy: req.user?.id,
      },
      conn,
    );
    await conn.commit();
    const [rows] = await db.execute("SELECT * FROM products WHERE id = ?", [id]);
    rows[0].prices = (await loadPrices([id]))[id] || {};
    return res.status(req.method === "POST" ? 201 : 200).json({ ...rows[0], linked });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: dupMessage(err) });
    console.error("[products] save failed:", err);
    return res.status(500).json({ error: "Could not save product" });
  } finally {
    conn.release();
  }
}

exports.create = (req, res) => save(req, res, null);
exports.update = (req, res) => save(req, res, toInt(req.params.id, 0));

exports.remove = async (req, res) => {
  try {
    const [r] = await db.execute("DELETE FROM products WHERE id = ?", [toInt(req.params.id, 0)]);
    if (!r.affectedRows) return res.status(404).json({ error: "Product not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("[products] delete failed:", err);
    return res.status(500).json({ error: "Could not delete product" });
  }
};
