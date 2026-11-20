// routes/index.js — every route in one place.
//
// Public (no login):
//   POST /webhooks/payhip        Payhip "paid"/"refunded"   (signature checked)
//   POST /webhooks/contact       Netlify contact form       (JWS checked)
//   POST /webhooks/signup        Netlify sign-up forms, e.g. offer-signup (JWS checked)
//   POST /api/signup             website sign-up form       (wishtune.com origin only)
//   POST /webhooks/teleagent     bot callbacks (dormant)    (shared token)
//   POST /webhooks/wylto         bot callbacks (dormant)    (shared token)
//   GET  /api/health
// Admin (Bearer token): /api/v1/*

const express = require("express");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");

const authenticateToken = require("../middleware/auth");
const verifyPayhipSignature = require("../middleware/payhipSignature");
const verifyNetlifySignature = require("../middleware/netlifySignature");

const auth = require("../controllers/authController");
const webhooks = require("../controllers/webhookController");
const signup = require("../controllers/signupController");
const contacts = require("../controllers/contactController");
const events = require("../controllers/eventController");
const products = require("../controllers/productController");
const settings = require("../controllers/settingsController");
const dashboard = require("../controllers/dashboardController");
const botWebhooks = require("../controllers/botWebhookController");

const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
const signupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "Too many attempts. Please try again in a few minutes." },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});

// ---- public ---------------------------------------------------------
const publicRouter = express.Router();
publicRouter.post("/webhooks/payhip", webhookLimiter, verifyPayhipSignature, webhooks.payhip);
publicRouter.post("/webhooks/contact", webhookLimiter, verifyNetlifySignature, webhooks.contact);
publicRouter.post("/webhooks/signup", webhookLimiter, verifyNetlifySignature, webhooks.netlifySignup);
publicRouter.post("/webhooks/teleagent", webhookLimiter, botWebhooks.teleagentAuth, botWebhooks.teleagent);
publicRouter.post("/webhooks/wylto", webhookLimiter, botWebhooks.wyltoAuth, botWebhooks.wylto);
publicRouter.options("/api/signup", cors(signup.corsOptions));
publicRouter.post("/api/signup", cors(signup.corsOptions), signupLimiter, signup.requireAllowedOrigin, signup.signup);
publicRouter.get("/api/health", (_req, res) =>
  res.json(require("../config/sandbox").isSandbox() ? { ok: true, sandbox: true } : { ok: true }),
);

// ---- admin ----------------------------------------------------------
const api = express.Router();
api.post("/auth/login", loginLimiter, auth.login);
api.post("/auth/refresh-token", auth.refreshToken);
api.post("/auth/logout", auth.logout);

api.use(authenticateToken);
api.post("/auth/change-password", auth.changePassword);

api.get("/dashboard/summary", dashboard.summary);

api.get("/contacts", contacts.list);
api.get("/contacts/filter-options", contacts.filterOptions);
api.get("/contacts/export.csv", contacts.exportCsv);
api.get("/contacts/:id", contacts.get);
api.patch("/contacts/:id", contacts.update);
api.post("/contacts/:id/notes", contacts.addNote);

api.get("/events", events.list);
api.get("/events/:id", events.get);

api.get("/products", products.list);
api.get("/products/unmapped", products.unmapped);
api.post("/products", products.create);
api.put("/products/:id", products.update);
api.delete("/products/:id", products.remove);

api.get("/settings/integrations", settings.integrations);
api.get("/settings/bots", settings.getBots);
api.put("/settings/bots", settings.updateBots);
api.post("/settings/bots/run-now", settings.runBotsNow);
api.get("/settings/internal", settings.getInternal);
api.put("/settings/internal", settings.updateInternal);
api.get("/imports", settings.imports);

module.exports = { publicRouter, api };
