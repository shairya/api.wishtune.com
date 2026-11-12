// controllers/webhookController.js — POST /webhooks/payhip and /webhooks/contact
//
// Both always answer 200 once the signature is valid, even for a rejected
// or duplicate event: the outcome is in the events log, and a non-200
// would only make Payhip/Netlify retry something that can never succeed.
// A 500 (database down) is the one case where a retry is wanted.

const { processEvent, processRefund } = require("../services/contactEventService");
const { insertEvent } = require("../services/eventLog");
const { parsePayhip } = require("../services/payhipParser");
const { parseNetlify } = require("../services/netlifyParser");

exports.payhip = async (req, res) => {
  const p = parsePayhip(req.body);
  try {
    if (p.type === "paid") {
      const result = await processEvent({
        source: "payhip",
        type: "sale",
        emailRaw: p.email,
        name: p.name,
        firstName: p.firstName,
        lastName: p.lastName,
        mobile: p.mobile,
        sale: {
          orderId: p.orderId,
          currency: p.currency,
          amountGross: p.amountGross,
          payhipFee: p.payhipFee,
          gatewayFee: p.gatewayFee,
          couponCode: p.discountCode,
          usedCoupon: p.usedCoupon,
          paymentType: p.paymentType,
          orderedAt: p.paidAt,
          items: p.items,
        },
        unconsented: p.unconsentedFromEmails,
        extra: { isGift: p.isGift },
        dedupeKey: p.orderId ? `payhip:paid:${p.orderId}` : null,
        payload: req.body,
        occurredAt: p.paidAt,
      });
      return res.status(200).json(result);
    }

    if (p.type === "refunded") {
      const result = await processRefund({
        emailRaw: p.email,
        orderId: p.orderId,
        amountRefunded: p.amountRefunded,
        refundedAt: p.refundedAt,
        payload: req.body,
        dedupeKey: `payhip:refunded:${p.orderId}`,
      });
      return res.status(200).json(result);
    }

    // subscription.* or anything else: not used by Wishtune — log and ignore.
    const eventId = await insertEvent({
      source: "payhip",
      type: p.type || "unknown",
      status: "ignored",
      emailRaw: p.email,
      summary: `Payhip "${p.type || "unknown"}" event ignored`,
      error: "Event type not handled by the CRM",
      payload: req.body,
    });
    return res.status(200).json({ status: "ignored", eventId });
  } catch (err) {
    console.error("[payhip] processing failed:", err);
    return res.status(500).json({ error: "Processing failed" });
  }
};

exports.contact = async (req, res) => {
  const n = parseNetlify(req.body);
  const onlyForm = (process.env.NETLIFY_CONTACT_FORM_NAME || "").trim();
  try {
    if (onlyForm && n.formName && n.formName !== onlyForm) {
      const eventId = await insertEvent({
        source: "contact_form",
        type: "contact_message",
        status: "ignored",
        emailRaw: n.email,
        summary: `Submission from form "${n.formName}" ignored`,
        error: `Only form "${onlyForm}" is accepted (NETLIFY_CONTACT_FORM_NAME)`,
        payload: req.body,
      });
      return res.status(200).json({ status: "ignored", eventId });
    }

    const result = await processEvent({
      source: "contact_form",
      type: "contact_message",
      emailRaw: n.email,
      name: n.name,
      mobile: n.mobile,
      message: n.message,
      page: n.page,
      utm: n.utm,
      extra: { formName: n.formName, formFields: Object.keys(n.otherFields).length ? n.otherFields : undefined },
      dedupeKey: n.submissionId ? `netlify:${n.submissionId}` : null,
      payload: req.body,
      occurredAt: n.createdAt,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("[contact] processing failed:", err);
    return res.status(500).json({ error: "Processing failed" });
  }
};
