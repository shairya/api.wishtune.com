// controllers/authController.js — login / refresh / logout.
// Short-lived access token in memory on the frontend + rotating refresh
// token in an httpOnly cookie (same design as oxxycrm).

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../config/mysql");

const ACCESS_TOKEN_EXPIRES_IN = "15m";
const REFRESH_DAYS = 7;
const REFRESH_COOKIE = "wt_refresh";
const COOKIE_PATH = "/api/v1/auth";

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
  };
}

function clearCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

function userResponse(u) {
  return { id: u.id, fullName: u.full_name, email: u.email, role: u.role };
}

function createAccessToken(u) {
  return jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

async function createRefreshToken(userId) {
  const token = jwt.sign({ id: userId, n: crypto.randomBytes(8).toString("hex") }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: `${REFRESH_DAYS}d`,
  });
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await db.execute("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)", [
    userId,
    hashToken(token),
    expiresAt,
  ]);
  return token;
}

exports.login = async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const [rows] = await db.execute("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
    const user = rows[0];
    // Same message for unknown email and wrong password.
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    await db.execute("UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?", [user.id]);
    res.cookie(REFRESH_COOKIE, await createRefreshToken(user.id), cookieOptions());
    return res.json({ success: true, accessToken: createAccessToken(user), user: userResponse(user) });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
};

exports.refreshToken = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: "Refresh token required" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const [rows] = await db.execute(
      "SELECT id FROM refresh_tokens WHERE token_hash = ? AND is_revoked = 0 AND expires_at > UTC_TIMESTAMP() LIMIT 1",
      [hashToken(token)],
    );
    if (!rows[0]) {
      // Reuse of a rotated token: revoke every session for this user.
      await db.execute("UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?", [decoded.id]);
      clearCookie(res);
      return res.status(403).json({ error: "Session expired. Please sign in again." });
    }
    const [users] = await db.execute("SELECT * FROM users WHERE id = ? LIMIT 1", [decoded.id]);
    const user = users[0];
    if (!user || !user.is_active) {
      clearCookie(res);
      return res.status(403).json({ error: "Account is unavailable" });
    }
    await db.execute("UPDATE refresh_tokens SET is_revoked = 1 WHERE id = ?", [rows[0].id]);
    res.cookie(REFRESH_COOKIE, await createRefreshToken(user.id), cookieOptions());
    return res.json({ success: true, accessToken: createAccessToken(user), user: userResponse(user) });
  } catch {
    clearCookie(res);
    return res.status(403).json({ error: "Invalid or expired refresh token" });
  }
};

exports.logout = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  try {
    if (token) await db.execute("UPDATE refresh_tokens SET is_revoked = 1 WHERE token_hash = ?", [hashToken(token)]);
  } catch (err) {
    console.error("Logout error:", err);
  }
  clearCookie(res);
  return res.json({ success: true });
};

exports.changePassword = async (req, res) => {
  const current = String(req.body?.currentPassword || "");
  const next = String(req.body?.newPassword || "");
  if (next.length < 10) return res.status(400).json({ error: "New password must be at least 10 characters" });
  const [rows] = await db.execute("SELECT * FROM users WHERE id = ? LIMIT 1", [req.user.id]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(current, user.password_hash))) {
    return res.status(400).json({ error: "Current password is incorrect" });
  }
  await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(next, 12), user.id]);
  return res.json({ success: true });
};
