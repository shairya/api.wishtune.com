/**
 * middleware/netlifySignature.js
 *
 * Netlify outgoing webhooks with a "JWS secret token" send an
 * X-Webhook-Signature header: a JWT signed HS256 with that secret, whose
 * claims include iss = "netlify" and sha256 = hex SHA-256 of the raw body.
 * We verify both. Fails closed when NETLIFY_JWS_SECRET is not configured.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

module.exports = function verifyNetlifySignature(req, res, next) {
  const secret = process.env.NETLIFY_JWS_SECRET;
  if (!secret) {
    console.error("[netlify] NETLIFY_JWS_SECRET is not set — rejecting webhook");
    return res.status(503).json({ error: "Contact webhook is not configured" });
  }

  const token = req.get("X-Webhook-Signature");
  if (!token || !req.rawBody) {
    return res.status(401).json({ error: "Missing signature" });
  }

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"], issuer: "netlify" });
    const bodyHash = crypto.createHash("sha256").update(req.rawBody).digest("hex");
    if (!decoded || decoded.sha256 !== bodyHash) {
      return res.status(401).json({ error: "Body does not match signature" });
    }
    return next();
  } catch (err) {
    console.warn("[netlify] invalid signature:", err.message);
    return res.status(401).json({ error: "Invalid signature" });
  }
};
