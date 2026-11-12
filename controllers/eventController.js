// controllers/eventController.js — the event log (incl. the error log of rejected events).

const db = require("../config/mysql");
const { toInt } = require("../lib/sql");
const { cleanText } = require("../lib/normalize");

exports.list = async (req, res) => {
  try {
    const where = [];
    const params = [];
    const status = cleanText(req.query.status, 20);
    const source = cleanText(req.query.source, 30);
    const type = cleanText(req.query.type, 40);
    const q = cleanText(req.query.q, 100);
    if (status) {
      where.push("e.status = ?");
      params.push(status);
    }
    if (source) {
      where.push("e.source = ?");
      params.push(source);
    }
    if (type) {
      where.push("e.type = ?");
      params.push(type);
    }
    if (q) {
      where.push("(e.email_raw LIKE ? OR c.primary_email LIKE ? OR e.summary LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const pageSize = toInt(req.query.pageSize, 50, { min: 1, max: 200 });
    const page = toInt(req.query.page, 1, { min: 1 });

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM events e LEFT JOIN contacts c ON c.id = e.contact_id ${sql}`,
      params,
    );
    const [rows] = await db.execute(
      `SELECT e.id, e.contact_id, c.primary_email AS contact_email, e.source, e.type, e.status, e.email_raw,
              e.summary, e.error, e.stage_before, e.stage_after, e.occurred_at, e.created_at
       FROM events e LEFT JOIN contacts c ON c.id = e.contact_id
       ${sql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    return res.json({ data: rows, total: Number(total), page, pageSize });
  } catch (err) {
    console.error("[events] list failed:", err);
    return res.status(500).json({ error: "Could not load events" });
  }
};

exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT e.*, c.primary_email AS contact_email FROM events e LEFT JOIN contacts c ON c.id = e.contact_id WHERE e.id = ?`,
      [toInt(req.params.id, 0)],
    );
    if (!rows[0]) return res.status(404).json({ error: "Event not found" });
    return res.json(rows[0]);
  } catch (err) {
    console.error("[events] get failed:", err);
    return res.status(500).json({ error: "Could not load event" });
  }
};
