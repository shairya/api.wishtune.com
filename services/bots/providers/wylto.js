/**
 * services/bots/providers/wylto.js — WhatsApp bot (Wylto).
 *
 * Request shape ported from oxxycrm's services/wyltoService.js
 * (POST /wa/send by raw phone number). A first WhatsApp message to someone
 * who has not messaged you must be an approved template, so this sends
 * WYLTO_TEMPLATE_NAME with the contact's first name as {{1}}.
 * Dormant until WYLTO_API_KEY + WYLTO_TEMPLATE_NAME are set and the
 * WhatsApp channel is switched on in Settings (and BOTS_ENABLED=true).
 */

const axios = require("axios");

class WyltoError extends Error {}

function config() {
  return {
    baseUrl: process.env.WYLTO_BASE_URL || "https://server.wylto.com/api/v1",
    apiKey: process.env.WYLTO_API_KEY || "",
    templateName: process.env.WYLTO_TEMPLATE_NAME || "",
    language: process.env.WYLTO_TEMPLATE_LANGUAGE || "en",
  };
}

module.exports = {
  name: "wylto",
  label: "Wylto",
  channel: "whatsapp",

  isConfigured() {
    const c = config();
    return Boolean(c.apiKey && c.templateName);
  },

  missingConfig() {
    const c = config();
    return [!c.apiKey && "WYLTO_API_KEY", !c.templateName && "WYLTO_TEMPLATE_NAME"].filter(Boolean);
  },

  async start(contact) {
    const c = config();
    if (!this.isConfigured()) throw new WyltoError(`Not configured: ${this.missingConfig().join(", ")}`);
    const firstName = contact.first_name || (contact.name || "").trim().split(" ")[0] || "there";
    try {
      const { data } = await axios.post(
        `${c.baseUrl}/wa/send`,
        {
          to: contact.mobile,
          clientMessageId: `wt-${contact.id}-${Date.now()}`,
          message: {
            type: "template",
            template: {
              name: c.templateName,
              language: { code: c.language },
              components: [{ type: "body", parameters: [{ type: "text", text: firstName }] }],
            },
          },
        },
        { timeout: 20000, headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" } },
      );
      const externalId = data?.messageId || data?.id || data?.data?.messageId || null;
      return { externalId: externalId ? String(externalId) : null, status: data?.status || "sent", raw: data };
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error || err.message;
      throw new WyltoError(`Wylto request failed: ${msg}`);
    }
  },
};
