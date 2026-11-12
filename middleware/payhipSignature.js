/**
 * middleware/payhipSignature.js
 *
 * Payhip's documented check: every webhook body carries a `signature`
 * field equal to sha256(<your Payhip API key>) as hex. We compare in
 * constant time and fail closed when PAYHIP_API_KEY is not configured.
 *
 * Note: this signature is derived from the API key only (not the body), so
 * it proves the sender knows the key but not that the body is untouched.
 * HTTPS covers the transport; keep the API key private.
 */

const crypto = require("crypto");

module.exports = function verifyPayhipSignature(req, res, next) {
  const apiKey = process.env.PAYHIP_API_KEY;
  if (!apiKey) {
    console.error("[payhip] PAYHIP_API_KEY is not set — rejecting webhook");
    return res.status(503).json({ error: "Payhip webhook is not configured" });
  }

  const provided = String(req.body?.signature || "").trim().toLowerCase();
  const expected = crypto.createHash("sha256").update(apiKey).digest("hex");

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (!provided || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn("[payhip] invalid or missing signature from", req.ip);
    return res.status(401).json({ error: "Invalid signature" });
  }
  return next();
};
