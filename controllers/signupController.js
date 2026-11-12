// controllers/signupController.js — POST /api/signup (website sign-up form)
//
// Accepts JSON or a normal form post with:
//   email (required), mobile, first_page_seen (or page),
//   utm_source, utm_medium, utm_campaign, consent (yes/no)
// plus an optional honeypot field "website" that real people leave empty.

const { processEvent } = require("../services/contactEventService");
const { insertEvent } = require("../services/eventLog");
const { parseBool } = require("../lib/normalize");

function allowedOrigins() {
  return (process.env.SIGNUP_ALLOWED_ORIGINS || "https://wishtune.com,https://www.wishtune.com")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Server-side origin check (CORS alone does not stop non-browser clients). */
exports.requireAllowedOrigin = (req, res, next) => {
  const origin = (req.get("Origin") || "").replace(/\/+$/, "");
  let refOrigin = "";
  try {
    refOrigin = req.get("Referer") ? new URL(req.get("Referer")).origin : "";
  } catch {
    refOrigin = "";
  }
  const list = allowedOrigins();
  if (list.includes(origin) || (!origin && list.includes(refOrigin))) return next();
  return res.status(403).json({ ok: false, error: "Origin not allowed" });
};

exports.corsOptions = {
  origin(origin, cb) {
    cb(null, Boolean(origin) && allowedOrigins().includes(origin.replace(/\/+$/, "")));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
  maxAge: 86400,
};

exports.signup = async (req, res) => {
  const b = req.body || {};

  if (b.website) {
    // Honeypot filled → bot. Pretend success, log it.
    await insertEvent({
      source: "signup",
      type: "signup",
      status: "ignored",
      emailRaw: b.email,
      summary: "Sign-up ignored (spam honeypot filled)",
      error: "Honeypot field filled",
      payload: b,
    }).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  try {
    const result = await processEvent({
      source: "signup",
      type: "signup",
      emailRaw: b.email,
      name: b.name,
      mobile: b.mobile || b.phone,
      page: b.first_page_seen || b.page,
      utm: { source: b.utm_source, medium: b.utm_medium, campaign: b.utm_campaign },
      consent: parseBool(b.consent),
      payload: { ...b, _ip: req.ip, _userAgent: req.get("User-Agent") },
    });

    if (result.status === "rejected") {
      return res.status(400).json({ ok: false, error: "Please enter a valid email address." });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[signup] processing failed:", err);
    return res.status(500).json({ ok: false, error: "Something went wrong. Please try again." });
  }
};
