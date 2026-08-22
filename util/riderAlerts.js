// Telling a rider what happened to their application, off-app.
//
// The in-app notification is already handled by util/deliveryNotify.js
// (notifyPartner), which writes a row and pushes over FCM. That reaches a rider
// who has the app installed, open or backgrounded, with a live token. This file
// covers the case that matters most for a decision they are waiting on: the
// rider who closed the app and is checking their phone.
//
// Separate from util/adminNotify.js on purpose — that one fans out to staff and
// resolves recipients by role. This one has exactly one recipient, already in
// hand, and different rules about what is safe to send.
//
// Never throws. An approval is written to the database before this runs; a dead
// SMTP host must not be able to make the rider's account un-approved.
const { sendMail, isRealAddress } = require("./email");
const { sendSms } = require("./sms");

const STORE = process.env.STORE_NAME || "My First Bite";

/**
 * Which channels are live for rider decisions.
 *
 * Defaults to BOTH, unlike the admin alerts: a rider waiting on an approval is
 * the person with the strongest claim on being told, and neither channel can
 * reach anyone who did not apply. Set RIDER_DECISION_CHANNELS to narrow it.
 */
const enabledChannels = () => {
  const raw = process.env.RIDER_DECISION_CHANNELS;
  return new Set(
    String(raw == null || raw === "" ? "email,sms" : raw)
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  );
};

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const firstName = (partner) => {
  const name = String(partner.dp_name || "").trim();
  return name ? name.split(/\s+/)[0] : "there";
};

const APPROVED = {
  subject: () => `${STORE} — you're approved 🎉`,
  sms: (p) =>
    `${STORE}: Good news ${firstName(p)}! Your delivery partner application is approved. ` +
    `Open the app and go online to start accepting orders.`,
  html: (p) =>
    `<p>Hi ${escapeHtml(firstName(p))},</p>` +
    `<p>Your delivery-partner application has been <strong>approved</strong>.</p>` +
    `<p>Open the ${escapeHtml(STORE)} partner app and go online — you can start accepting ` +
    `orders straight away.</p>` +
    `<p>Welcome aboard.</p>`,
};

const REJECTED = {
  subject: () => `${STORE} — action needed on your application`,
  sms: (p, reason) =>
    `${STORE}: Hi ${firstName(p)}, your delivery partner application needs a change before ` +
    `we can approve it. Reason: ${reason} Open the app to update and resubmit.`,
  html: (p, reason) =>
    `<p>Hi ${escapeHtml(firstName(p))},</p>` +
    `<p>We could not approve your delivery-partner application yet.</p>` +
    `<p><strong>What needs fixing:</strong> ${escapeHtml(reason)}</p>` +
    `<p>Open the ${escapeHtml(STORE)} partner app to update your details and submit again.</p>`,
};

/**
 * Emails and texts a rider the outcome of their application.
 *
 * Returns a per-channel report; never throws. A skipped channel is reported
 * with a reason rather than silently doing nothing, because "the rider says
 * they got nothing" is otherwise unanswerable.
 */
async function alertRiderDecision(partner, { approved, reason } = {}) {
  const result = { email: null, sms: null, channels: [] };
  try {
    const channels = enabledChannels();
    result.channels = [...channels];
    const copy = approved ? APPROVED : REJECTED;
    const why = reason || "Some details need to be corrected.";

    if (channels.has("email")) {
      const to = partner.dp_email;
      result.email = isRealAddress(to)
        ? await sendMail({
            to,
            subject: copy.subject(),
            html: approved ? copy.html(partner) : copy.html(partner, why),
          })
        : { sent: false, reason: "no real address on file (placeholder or blank)" };
    }

    if (channels.has("sms")) {
      result.sms = await sendSms(
        partner.dp_phone,
        approved ? copy.sms(partner) : copy.sms(partner, why)
      );
    }
  } catch (err) {
    console.log("MFB-error-logs ~ alertRiderDecision ~", err.message);
    result.error = err.message;
  }
  return result;
}

module.exports = {
  alertRiderDecision,
  _enabledChannels: enabledChannels,
};
