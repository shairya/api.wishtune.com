// middleware/auth.js — Bearer access-token check (same contract as oxxycrm:
// 401 on missing/invalid token so the frontend's apiFetch refreshes and retries).

const jwt = require("jsonwebtoken");

module.exports = function authenticateToken(req, res, next) {
  const authorization = req.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access denied: token missing" });
  }
  try {
    req.user = jwt.verify(authorization.slice(7).trim(), process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Access denied: token invalid or expired" });
  }
};
