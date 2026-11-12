/**
 * services/bots/providers/teleagent.js — voice bot (TeleAgent).
 *
 * Request shape ported from oxxycrm's services/teleAgentService.js
 * (POST /leads with triggerCall: true), keyed to a Wishtune contact.
 * Dormant until TELEAGENT_API_KEY + TELEAGENT_CAMPAIGN_ID are set and the
 * voice channel is switched on in Settings (and BOTS_ENABLED=true).
 */

const axios = require("axios");

class TeleAgentError extends Error {}

function config() {
  return {
    baseUrl: process.env.TELEAGENT_BASE_URL || "https://www.teleagentai.in/api/v1",
    apiKey: process.env.TELEAGENT_API_KEY || "",
    campaignId: process.env.TELEAGENT_CAMPAIGN_ID || "",
    promptName: process.env.TELEAGENT_PROMPT_NAME || "default",
  };
}

module.exports = {
  name: "teleagent",
  label: "TeleAgent",
  channel: "voice",

  isConfigured() {
    const c = config();
    return Boolean(c.apiKey && c.campaignId);
  },

  missingConfig() {
    const c = config();
    return [!c.apiKey && "TELEAGENT_API_KEY", !c.campaignId && "TELEAGENT_CAMPAIGN_ID"].filter(Boolean);
  },

  /** @returns {Promise<{ externalId: string, status: string, raw: object }>} */
  async start(contact) {
    const c = config();
    if (!this.isConfigured()) throw new TeleAgentError(`Not configured: ${this.missingConfig().join(", ")}`);
    try {
      const { data } = await axios.post(
        `${c.baseUrl}/leads`,
        {
          name: contact.name || undefined,
          phone: contact.mobile,
          email: contact.email,
          campaignId: Number(c.campaignId) || c.campaignId,
          triggerCall: true,
          promptName: c.promptName,
        },
        { timeout: 20000, headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" } },
      );
      // TeleAgent can answer 200 without placing a call (e.g. "skipped_gemini_outage").
      if (data?.callId === undefined || data?.callId === null || data?.callId === "") {
        throw new TeleAgentError(`No call placed (status: ${data?.callStatus || "unknown"})`);
      }
      return { externalId: String(data.callId), status: data.callStatus || "initiated", raw: data };
    } catch (err) {
      if (err instanceof TeleAgentError) throw err;
      const msg = err.response?.data?.message || err.response?.data?.error || err.message;
      throw new TeleAgentError(`TeleAgent request failed: ${msg}`);
    }
  },
};
