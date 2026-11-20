require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

const db = require("./config/mysql");
const sandbox = require("./config/sandbox");
const { publicRouter, api } = require("./routes");
const { startBotOutreachCron } = require("./jobs/botOutreachCron");

for (const key of ["JWT_SECRET", "JWT_REFRESH_SECRET", "COOKIE_SECRET"]) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env — run "npm run secrets" and paste the output into .env`);
    process.exit(1);
  }
}

try {
  sandbox.assertSafeEnvironment();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (sandbox.isSandbox()) {
  const s = sandbox.describe();
  console.log(
    `*** SANDBOX MODE — outbound limited to ${s.users.filter((u) => u.mobile).length} allowlisted number(s); real customer data is anonymised on arrival ***`,
  );
  if (s.error) console.warn(`[sandbox] ${s.error}`);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind nginx: real client IP for rate limits

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));

// Raw body is kept for the Netlify signature (it hashes the exact bytes).
const keepRaw = (req, _res, buf) => {
  req.rawBody = buf;
};
app.use(express.json({ limit: "200kb", verify: keepRaw }));
app.use(express.urlencoded({ extended: true, limit: "200kb", verify: keepRaw }));
app.use(cookieParser(process.env.COOKIE_SECRET));

// Public endpoints carry their own CORS rules (/api/signup → wishtune.com only).
app.use(publicRouter);

// Admin API. In production the frontend is same-origin (crm.wishtune.com), so
// CORS only matters for local development (CORS_ORIGINS=http://localhost:3100).
const adminOrigins = [process.env.APP_URL, ...(process.env.CORS_ORIGINS || "").split(",")]
  .map((o) => (o || "").trim().replace(/\/+$/, ""))
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
const warnedOrigins = new Set();
// Outside production, any http://localhost:<port> / 127.0.0.1 frontend may call the API.
const isLocalDev = (origin) => !isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
app.use(
  "/api/v1",
  cors({
    origin: (origin, cb) => {
      const ok = !origin || adminOrigins.includes(origin) || isLocalDev(origin);
      if (!ok && !warnedOrigins.has(origin)) {
        warnedOrigins.add(origin);
        console.warn(
          `[cors] blocked admin request from ${origin}. Allowed: ${adminOrigins.join(", ") || "(none)"}` +
            (isProduction ? ". For local development set NODE_ENV=development, or add it to CORS_ORIGINS." : ". Add it to CORS_ORIGINS."),
        );
      }
      cb(null, ok);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
  api,
);

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Malformed JSON etc.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Body too large" });
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Server error" });
});

const PORT = Number(process.env.PORT || 5100);

async function start() {
  try {
    await db.query("SELECT 1");
  } catch (err) {
    console.error("Cannot connect to MySQL:", err.message);
    process.exit(1);
  }
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`Wishtune CRM API listening on 127.0.0.1:${PORT}`);
    if (process.env.DISABLE_CRON !== "true") startBotOutreachCron();
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use — usually the CRM is already running under pm2.\n` +
          `  Check:  pm2 ls   and   sudo ss -ltnp | grep ${PORT}\n` +
          "  Restart the pm2 copy with  pm2 restart <name>  instead of running  node server.js  by hand,\n" +
          "  or set a different PORT in .env (and in the nginx config).",
      );
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });
}

if (require.main === module) start();

module.exports = app;
