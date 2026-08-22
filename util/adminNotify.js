// Admin alerting — the single entry point for telling admin staff something
// happened. Today that is one event: a rider has applied and is waiting.
//
// Four channels, in the order they are attempted:
//
//   panel     a row in store_user_notifications, one per admin. This is the
//             durable copy — the only one that survives nobody being logged in.
//   realtime  an SSE event, so an open panel updates without a refresh.
//   email     via the existing nodemailer/SendGrid transport.
//   sms       via the Twilio Messaging API (util/sms.js).
//
// TWO RULES THIS MODULE KEEPS
//
// 1. It never throws. Every caller raises an alert as a side effect of
//    something that matters more — an application being submitted, a rider
//    being approved. A dead SMTP host must not be able to fail that, so
//    failures come back as values and the caller can ignore them.
//
// 2. Admins only. Recipients are resolved by user_role, and store_users holds
//    customers, vendors and riders in the same table — a query without the
//    role filter would text every customer in the database.
const { Op } = require("sequelize");

const { User, UserNotification } = require("../models");
const { sendMail, isRealAddress } = require("./email");
const { sendSmsMany } = require("./sms");
const { adminPhones } = require("./vendorAlerts");
const { publish } = require("./realtime");

// Admin staff are roles 0/1/2 — see middlewares/verifyAdmin.js.
const ADMIN_ROLES = [0, 1, 2];

const STORE = process.env.STORE_NAME || "My First Bite";

const trimTrailingSlashes = (s) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end -= 1;
  return s.slice(0, end);
};

// Where to send someone to act. Configuration first: a sweeper or an app
// request has no browser origin to borrow, and a wrong value here ships a dead
// link to a real phone.
const panelUrl = () => {
  const origins = require("./origins");
  return process.env.PANEL_URL
    ? trimTrailingSlashes(process.env.PANEL_URL)
    : origins.webBase(null);
};

const requestsUrl = () => `${panelUrl()}/admin/rider-requests`;

/**
 * Which channels are live.
 *
 * Defaults to "panel" alone, and that default is deliberate: the panel row and
 * the SSE event are free and local, while email and SMS cost money and reach
 * real people. Turning those on is a decision someone makes on purpose.
 *
 *   RIDER_ALERT_CHANNELS=panel,realtime,email,sms
 *
 * "panel" implies "realtime" — they are the same news, one durable and one
 * immediate, and splitting them only creates a way to be inconsistent.
 */
const enabledChannels = () => {
  const raw = process.env.RIDER_ALERT_CHANNELS;
  const list = String(raw == null || raw === "" ? "panel" : raw)
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const set = new Set(list);
  if (set.has("panel")) set.add("realtime");
  return set;
};

/** Admin staff rows. Role-filtered at the database, not in JavaScript. */
const adminUsers = () =>
  User.findAll({
    where: { user_role: { [Op.in]: ADMIN_ROLES } },
    attributes: ["user_id", "user_name", "user_email"],
  });

/**
 * Who gets the mail. RIDER_ALERT_EMAILS narrows it to the people who actually
 * review applications; without it, every admin account gets one. This database
 * has several, and one mail each is both slow and a good way to get an SMTP
 * account rate-limited — the same reasoning as ORDER_ALERT_EMAILS.
 */
const mailRecipients = (admins) => {
  const configured = String(process.env.RIDER_ALERT_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return admins
    .map((a) => a.user_email)
    .filter((e) => isRealAddress(e));
};

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * A rider has submitted their application and is waiting on a decision.
 *
 * Returns a per-channel report rather than throwing. The caller logs it and
 * carries on; nothing about the submission depends on any of this working.
 */
async function notifyAdminsRiderApplied(partner) {
  const result = { panel: 0, realtime: 0, email: null, sms: null, channels: [] };
  try {
    const channels = enabledChannels();
    result.channels = [...channels];

    const name = partner.dp_name || `Rider ${String(partner.dp_phone || "").slice(-4)}`;
    const phone = partner.dp_phone || "";
    const title = "New rider application";
    const body = `${name} (${phone}) is waiting for approval.`;

    // Only when a channel actually needs them. With everything switched off
    // this must not touch the database at all.
    const needsAdmins = channels.has("panel") || channels.has("email");
    const admins = needsAdmins ? await adminUsers() : [];

    // 1. The durable copy.
    if (channels.has("panel") && admins.length > 0) {
      try {
        const rows = await UserNotification.bulkCreate(
          admins.map((a) => ({
            user_id: a.user_id,
            category: "system",
            icon: "delivery_dining",
            title,
            body,
            ref_partner_id: partner.dp_id,
            is_read: false,
            created_at: new Date(),
          }))
        );
        result.panel = rows.length;
      } catch (err) {
        console.log("MFB-error-logs ~ adminNotify panel ~", err.message);
      }
    }

    // 2. The immediate copy. Deliberately after the row exists, so a panel
    //    that refetches on the event finds the notification already there.
    if (channels.has("realtime")) {
      result.realtime = publish(
        "rider.applied",
        { dp_id: partner.dp_id, name, phone, title, body, at: new Date().toISOString() },
        { audience: "admin" }
      );
    }

    // 3. Email.
    if (channels.has("email")) {
      const to = mailRecipients(admins);
      result.email = to.length
        ? await sendMail({
            to: to.join(","),
            subject: `${STORE} — new rider application from ${name}`,
            html:
              `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(phone)}) has submitted ` +
              `a delivery-partner application and is waiting for approval.</p>` +
              `<p><a href="${requestsUrl()}">Review the application</a></p>`,
          })
        : { sent: false, reason: "no admin address (RIDER_ALERT_EMAILS)" };
    }

    // 4. SMS. Same explicit opt-in list the vendor escalations use, so there is
    //    one place that decides whose personal mobile rings.
    if (channels.has("sms")) {
      const phones = adminPhones();
      result.sms = phones.length
        ? await sendSmsMany(
            phones,
            `New rider application: ${name} (${phone}) is waiting for approval.\n${requestsUrl()}`
          )
        : { sent: 0, attempted: 0, reason: "no admin phone numbers (ADMIN_ALERT_PHONES)" };
    }
  } catch (err) {
    // The outer net. Nothing above should reach here, but "an alert broke a
    // rider's application" is not a trade this module is allowed to make.
    console.log("MFB-error-logs ~ notifyAdminsRiderApplied ~", err.message);
    result.error = err.message;
  }
  return result;
}

module.exports = {
  notifyAdminsRiderApplied,
  // Exported for tests: these are pure decisions worth testing without a
  // database or a live SMTP host behind them.
  _enabledChannels: enabledChannels,
  _mailRecipients: mailRecipients,
  ADMIN_ROLES,
};
