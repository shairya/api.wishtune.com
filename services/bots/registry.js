// services/bots/registry.js — add a new bot provider here and it appears in Settings.

const teleagent = require("./providers/teleagent");
const wylto = require("./providers/wylto");
const sandbox = require("../../config/sandbox");

const PROVIDERS = { teleagent, wylto };

/**
 * Every provider is returned wrapped: in sandbox mode start() refuses any
 * number that is not on the allowlist, whatever the caller did before.
 */
function guarded(p) {
  return {
    ...p,
    isConfigured: () => p.isConfigured(),
    missingConfig: () => p.missingConfig(),
    async start(contact) {
      if (!sandbox.canContactMobile(contact.mobile)) {
        throw new sandbox.SandboxBlockedError(`Sandbox: ${contact.mobile || "(no number)"} is not on the allowlist — not contacted`);
      }
      return p.start(contact);
    },
  };
}

function getProvider(name) {
  return PROVIDERS[name] ? guarded(PROVIDERS[name]) : null;
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
