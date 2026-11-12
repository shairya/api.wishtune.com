// services/bots/registry.js — add a new bot provider here and it appears in Settings.

const teleagent = require("./providers/teleagent");
const wylto = require("./providers/wylto");

const PROVIDERS = { teleagent, wylto };

function getProvider(name) {
  return PROVIDERS[name] || null;
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    name: p.name,
    label: p.label,
    channel: p.channel,
    configured: p.isConfigured(),
    missing: p.missingConfig(),
  }));
}

function botsMasterSwitch() {
  return String(process.env.BOTS_ENABLED || "").toLowerCase() === "true";
}

module.exports = { getProvider, listProviders, botsMasterSwitch };
