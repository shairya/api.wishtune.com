// controllers/settingsController.js — bot settings + integration status.

const { getSetting, setSetting } = require("../services/settingsService");
const { listProviders, botsMasterSwitch, getProvider } = require("../services/bots/registry");
const { runOutreachOnce } = require("../services/bots/outreachService");
const { insertEvent } = require("../services/eventLog");
const db = require("../config/mysql");

const STAGES = ["contact", "subscriber", "customer", "repeat_buyer"];
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

exports.getBots = async (_req, res) => {
  try {
    const settings = await getSetting("bots");
    const [[counts]] = await db.execute(
      `SELECT
         (SELECT COUNT(*) FROM contacts WHERE primary_mobile IS NOT NULL AND unsubscribed = 0 AND is_internal = 0 AND merged_into_id IS NULL) AS with_mobile,
         (SELECT COUNT(*) FROM bot_outreach WHERE status = 'sent' OR status = 'completed') AS reached,
         (SELECT COUNT(*) FROM bot_outreach WHERE status = 'failed') AS failed`,
    );
    return res.json({ settings, providers: listProviders(), masterSwitch: botsMasterSwitch(), counts });
  } catch (err) {
    console.error("[settings] bots get failed:", err);
    return res.status(500).json({ error: "Could not load bot settings" });
  }
};

exports.updateBots = async (req, res) => {
  const b = req.body || {};
  const current = await getSetting("bots");
  const next = { ...current };
  const errors = [];

  for (const channel of ["voice", "whatsapp"]) {
    if (b[channel]) {
      const provider = b[channel].provider ?? current[channel].provider;
      const p = getProvider(provider);
      if (!p || p.channel !== channel) errors.push(`Unknown ${channel} provider "${provider}"`);
      next[channel] = { enabled: Boolean(b[channel].enabled), provider };
    }
  }
  if (b.delayMinutes !== undefined) {
    const n = parseInt(b.delayMinutes, 10);
    if (!Number.isFinite(n) || n < 0 || n > 10080) errors.push("Delay must be 0–10080 minutes");
    else next.delayMinutes = n;
  }
  if (b.batchSize !== undefined) {
    const n = parseInt(b.batchSize, 10);
    if (!Number.isFinite(n) || n < 1 || n > 200) errors.push("Batch size must be 1–200");
    else next.batchSize = n;
  }
  if (b.maxAttempts !== undefined) {
    const n = parseInt(b.maxAttempts, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10) errors.push("Max attempts must be 1–10");
    else next.maxAttempts = n;
  }
  if (b.eligibleStages !== undefined) {
    if (!Array.isArray(b.eligibleStages) || b.eligibleStages.some((s) => !STAGES.includes(s))) {
      errors.push("Invalid eligible stages");
    } else next.eligibleStages = b.eligibleStages;
  }
  if (b.businessHours !== undefined) {
    const { start, end } = b.businessHours || {};
    if (!HHMM.test(start || "") || !HHMM.test(end || "")) errors.push("Business hours must be HH:MM");
    else next.businessHours = { start, end };
  }
  if (errors.length) return res.status(400).json({ error: errors.join(". ") });

  try {
    await setSetting("bots", next, req.user?.id);
    await insertEvent({
      source: "admin",
      type: "settings_changed",
      summary: "Bot settings updated",
      details: { before: current, after: next },
      createdBy: req.user?.id,
    }).catch(() => {});
    return res.json({ settings: next });
  } catch (err) {
    console.error("[settings] bots update failed:", err);
    return res.status(500).json({ error: "Could not save bot settings" });
  }
};

exports.runBotsNow = async (_req, res) => {
  try {
    return res.json(await runOutreachOnce({ force: true }));
  } catch (err) {
    console.error("[settings] run bots failed:", err);
    return res.status(500).json({ error: "Run failed" });
  }
};

/** What is wired up — shown on the Settings page so setup gaps are visible. */
exports.integrations = async (_req, res) => {
  const base = (process.env.APP_URL || "https://crm.wishtune.com").replace(/\/+$/, "");
  try {
    const [last] = await db.execute(
      `SELECT source, MAX(created_at) AS last_at FROM events
       WHERE source IN ('payhip','signup','contact_form') AND status = 'processed'
       GROUP BY source`,
    );
    const lastBySource = Object.fromEntries(last.map((r) => [r.source, r.last_at]));
    return res.json({
      payhip: {
        url: `${base}/webhooks/payhip`,
        configured: Boolean(process.env.PAYHIP_API_KEY),
        lastEventAt: lastBySource.payhip || null,
      },
      signup: {
        url: `${base}/api/signup`,
        allowedOrigins: (process.env.SIGNUP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
        configured: true,
        lastEventAt: lastBySource.signup || null,
      },
      contact: {
        url: `${base}/webhooks/contact`,
        configured: Boolean(process.env.NETLIFY_JWS_SECRET),
        formName: process.env.NETLIFY_CONTACT_FORM_NAME || null,
        lastEventAt: lastBySource.contact_form || null,
      },
      bots: {
        teleagentWebhookUrl: `${base}/webhooks/teleagent?token=<TELEAGENT_WEBHOOK_SECRET>`,
        wyltoWebhookUrl: `${base}/webhooks/wylto?token=<WYLTO_WEBHOOK_SECRET>`,
      },
      metaPixelNote: "The Meta Pixel stays in the browser and sends nothing to the CRM.",
    });
  } catch (err) {
    console.error("[settings] integrations failed:", err);
    return res.status(500).json({ error: "Could not load integration status" });
  }
};

/* ------------------------------------------------------------------ */
/* Test contacts (team / internal)                                     */
/* ------------------------------------------------------------------ */

const { getRules, saveRules, applyRulesToAll } = require("../services/internalService");

exports.getInternal = async (_req, res) => {
  try {
    const [[{ n }]] = await db.execute("SELECT COUNT(*) AS n FROM contacts WHERE is_internal = 1 AND merged_into_id IS NULL");
    return res.json({ rules: await getRules(), flaggedContacts: Number(n) });
  } catch (err) {
    console.error("[settings] internal get failed:", err);
    return res.status(500).json({ error: "Could not load the test list" });
  }
};

/** PUT /settings/internal { emails:[], domains:[], coupons:[] } — saves and re-applies to every contact. */
exports.updateInternal = async (req, res) => {
  const split = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\s,;]+/));
  try {
    const before = await getRules();
    const rules = await saveRules(
      { emails: split(req.body?.emails), domains: split(req.body?.domains), coupons: split(req.body?.coupons) },
      req.user?.id,
    );
    const applied = await applyRulesToAll();
    await insertEvent({
      source: "admin",
      type: "settings_changed",
      summary: `Test list updated · ${applied.flagged} flagged, ${applied.unflagged} unflagged`,
      details: { before, after: rules, applied },
      createdBy: req.user?.id,
    }).catch(() => {});
    return res.json({ rules, ...applied });
  } catch (err) {
    console.error("[settings] internal update failed:", err);
    return res.status(500).json({ error: "Could not save the test list" });
  }
};

/* ------------------------------------------------------------------ */
/* Import history                                                      */
/* ------------------------------------------------------------------ */

exports.imports = async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT id, source, file_name, is_dry_run, status, rows_total, rows_created, rows_duplicate, rows_rejected,
              contacts_created, run_by, started_at, finished_at
       FROM import_batches ORDER BY id DESC LIMIT 50`,
    );
    return res.json({ data: rows });
  } catch (err) {
    console.error("[settings] imports failed:", err);
    return res.status(500).json({ error: "Could not load import history" });
  }
};
