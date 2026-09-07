// Admin alerting — the single entry point for telling admin staff something
// happened.
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
//    something that matters more — an application being submitted, an order
//    being cancelled. A dead SMTP host must not be able to fail that, so
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
const orderUrl = (id) => `${panelUrl()}/admin/orders/${id}`;

/**
 * Parses a comma-separated channel list, defaulting when unset OR blank.
 *
 * The blank case matters: an env var cleared in a dashboard arrives as "", and
 * treating that as "no channels" would silently switch off the durable panel
 * notification, which is the one that must never be lost. Use the literal
 * "none" to mean none.
 */
const parseChannels = (raw, fallback) => {
  const set = new Set(
    String(raw == null || raw === "" ? fallback : raw)
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  );
  // The panel row and the SSE event are the same news, one durable and one
  // immediate. Splitting them only creates a way to be inconsistent.
  if (set.has("panel")) set.add("realtime");
  return set;
};

/**
 * Rider applications. Defaults to "panel": the panel row and the SSE event are
 * free and local, while email and SMS cost money and reach real people.
 *
 *   RIDER_ALERT_CHANNELS=panel,email,sms
 */
const enabledChannels = () => parseChannels(process.env.RIDER_ALERT_CHANNELS, "panel");

/**
 * Order escalations — a vendor sitting on an order, and the auto-cancel that
 * follows. Also "panel" by default.
 *
 * These used to be email + WhatsApp unconditionally. They are gated rather
 * than deleted, so turning the noisier channels back on for a busy period is
 * an env change and not a deploy.
 *
 *   ORDER_ESCALATION_CHANNELS=panel,email,sms
 */
const escalationChannels = () =>
  parseChannels(process.env.ORDER_ESCALATION_CHANNELS, "panel");

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
const mailRecipients = (admins, envVar = "RIDER_ALERT_EMAILS") => {
  const configured = String(process.env[envVar] || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return admins.map((a) => a.user_email).filter((e) => isRealAddress(e));
};

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Writes one notification row per admin. Returns how many landed.
 *
 * bulkCreate rather than a loop: this runs inside a request or a sweeper tick,
 * and six round trips where one would do is six chances to be slow.
 */
async function raisePanel(admins, { title, body, icon, refOrderId, refPartnerId }) {
  if (admins.length === 0) return 0;
  try {
    const rows = await UserNotification.bulkCreate(
      admins.map((a) => ({
        user_id: a.user_id,
        category: "system",
        icon: icon || "notifications",
        title,
        body,
        ref_order_id: refOrderId ?? null,
        ref_partner_id: refPartnerId ?? null,
        is_read: false,
        created_at: new Date(),
      }))
    );
    return rows.length;
  } catch (err) {
    console.log("MFB-error-logs ~ adminNotify panel ~", err.message);
    return 0;
  }
}

/**
 * The shared shape of every admin alert: resolve recipients, write the durable
 * rows, publish the live event, then the optional paid channels.
 *
 * `mail` and `sms` are builders rather than strings so nothing is rendered for
 * a channel that is switched off.
 */
async function fanOut({ channels, notification, event, payload, mail, sms, mailEnvVar }) {
  const result = { panel: 0, realtime: 0, email: null, sms: null, channels: [...channels] };

  // Only when a channel actually needs them. With everything switched off this
  // must not touch the database at all.
  const needsAdmins = channels.has("panel") || channels.has("email");
  const admins = needsAdmins ? await adminUsers() : [];

  if (channels.has("panel")) {
    result.panel = await raisePanel(admins, notification);
  }

  // After the row exists, so a panel that refetches on the event finds it.
  if (channels.has("realtime")) {
    result.realtime = publish(event, payload, { audience: "admin" });
  }

  if (channels.has("email") && mail) {
    const to = mailRecipients(admins, mailEnvVar);
    result.email = to.length
      ? await sendMail({ to: to.join(","), ...mail() })
      : { sent: false, reason: `no admin address (${mailEnvVar})` };
  }

  // Same explicit opt-in list the vendor escalations use, so there is one place
  // that decides whose personal mobile rings.
  if (channels.has("sms") && sms) {
    const phones = adminPhones();
    result.sms = phones.length
      ? await sendSmsMany(phones, sms())
      : { sent: 0, attempted: 0, reason: "no admin phone numbers (ADMIN_ALERT_PHONES)" };
  }

  return result;
}

/** A rider has submitted their application and is waiting on a decision. */
async function notifyAdminsRiderApplied(partner) {
  try {
    const name = partner.dp_name || `Rider ${String(partner.dp_phone || "").slice(-4)}`;
    const phone = partner.dp_phone || "";
    const title = "New rider application";
    const body = `${name} (${phone}) is waiting for approval.`;

    return await fanOut({
      channels: enabledChannels(),
      mailEnvVar: "RIDER_ALERT_EMAILS",
      notification: { title, body, icon: "delivery_dining", refPartnerId: partner.dp_id },
      event: "rider.applied",
      payload: { dp_id: partner.dp_id, name, phone, title, body, at: new Date().toISOString() },
      mail: () => ({
        subject: `${STORE} — new rider application from ${name}`,
        html:
          `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(phone)}) has submitted ` +
          `a delivery-partner application and is waiting for approval.</p>` +
          `<p><a href="${requestsUrl()}">Review the application</a></p>`,
      }),
      sms: () =>
        `New rider application: ${name} (${phone}) is waiting for approval.\n${requestsUrl()}`,
    });
  } catch (err) {
    // The outer net. Nothing above should reach here, but "an alert broke a
    // rider's application" is not a trade this module is allowed to make.
    console.log("MFB-error-logs ~ notifyAdminsRiderApplied ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

/** A vendor is sitting on an order the customer is already waiting for. */
async function notifyAdminsOrderStuck({ orderId, shop, minutesWaiting, minutesUntilCancel, vendorPhone }) {
  try {
    const title = `Order #${orderId} not accepted`;
    const deadline =
      minutesUntilCancel > 0
        ? ` Auto-cancels in ${minutesUntilCancel} min.`
        : "";
    const body = `${shop} has not responded for ${minutesWaiting} min.${deadline}`;

    return await fanOut({
      channels: escalationChannels(),
      mailEnvVar: "ORDER_ALERT_EMAILS",
      notification: { title, body, icon: "schedule", refOrderId: orderId },
      event: "order.stuck",
      payload: { order_id: orderId, shop, minutes_waiting: minutesWaiting, title, body },
      mail: () => ({
        subject: `⚠️ Order #${orderId} not accepted after ${minutesWaiting} minutes`,
        html:
          `<p><strong>${escapeHtml(shop)}</strong> has not accepted order #${orderId}, ` +
          `${minutesWaiting} minutes after it was placed. The customer is still waiting.</p>` +
          (minutesUntilCancel > 0
            ? `<p style="color:#b00020"><strong>Auto-cancels in ${minutesUntilCancel} minute(s)</strong>, refunding any online payment.</p>`
            : "") +
          (vendorPhone ? `<p>Vendor phone: ${escapeHtml(vendorPhone)}</p>` : "") +
          `<p><a href="${orderUrl(orderId)}">Open the order</a></p>`,
      }),
      sms: () =>
        `Order #${orderId} not accepted. ${shop} silent for ${minutesWaiting} min.${deadline}\n${orderUrl(orderId)}`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsOrderStuck ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

/**
 * The 6-minute "final warning" tier. Unlike notifyAdminsOrderStuck, email and
 * the panel row are forced on regardless of ORDER_ESCALATION_CHANNELS — this
 * step is defined to email admin staff and to ring AdminBell a second time.
 * SMS still follows the channel config, since that one rings personal phones.
 */
async function notifyAdminsOrderFinalWarning({
  orderId,
  shop,
  minutesWaiting,
  minutesUntilCancel,
  vendorPhone,
}) {
  try {
    const title = `Order #${orderId} — final warning`;
    const deadline =
      minutesUntilCancel > 0 ? ` Auto-cancels in ${minutesUntilCancel} min.` : "";
    const body = `${shop} still hasn't accepted after ${minutesWaiting} min.${deadline}`;

    const channels = escalationChannels();
    channels.add("panel");
    channels.add("realtime");
    channels.add("email");

    return await fanOut({
      channels,
      mailEnvVar: "ORDER_ALERT_EMAILS",
      notification: { title, body, icon: "schedule", refOrderId: orderId },
      // Reuses the order.stuck event the panel already listens for; AdminBell
      // rings off the new notification row, not the event name.
      event: "order.stuck",
      payload: { order_id: orderId, shop, minutes_waiting: minutesWaiting, title, body },
      mail: () => ({
        subject: `⚠️ Final warning — order #${orderId} not accepted after ${minutesWaiting} minutes`,
        html:
          `<p><strong>${escapeHtml(shop)}</strong> has still not accepted order #${orderId}, ` +
          `${minutesWaiting} minutes after it was placed. The customer is still waiting.</p>` +
          (minutesUntilCancel > 0
            ? `<p style="color:#b00020"><strong>Auto-cancels in ${minutesUntilCancel} minute(s)</strong>, refunding any online payment.</p>`
            : "") +
          (vendorPhone ? `<p>Vendor phone: ${escapeHtml(vendorPhone)}</p>` : "") +
          `<p><a href="${orderUrl(orderId)}">Open the order</a></p>`,
      }),
      sms: () =>
        `Order #${orderId} FINAL warning. ${shop} silent ${minutesWaiting} min.${deadline}\n${orderUrl(orderId)}`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsOrderFinalWarning ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

/**
 * Dispatch found no rider. The customer's order is cooked (or cooking) and
 * nobody is coming for it, so this needs a human now: bell + live event +
 * email, all forced on regardless of ORDER_ESCALATION_CHANNELS. The panel's
 * unassigned section reads the same 'failed' job this fires alongside.
 */
async function notifyAdminsNoRider({ orderId, doId, pickup, dropArea, minutesWaiting }) {
  try {
    const route = `${pickup || "Pickup"} → ${dropArea || "drop"}`;
    const title = `Order #${orderId} — no rider`;
    const body = `No rider accepted after ${minutesWaiting} min (${route}). Assign one manually.`;

    const channels = escalationChannels();
    channels.add("panel");
    channels.add("realtime");
    channels.add("email");

    return await fanOut({
      channels,
      mailEnvVar: "ORDER_ALERT_EMAILS",
      notification: { title, body, icon: "no_transfer", refOrderId: orderId },
      event: "order.norider",
      payload: { order_id: orderId, do_id: doId, route, minutes_waiting: minutesWaiting, title, body },
      mail: () => ({
        subject: `🛵 Order #${orderId} has no rider after ${minutesWaiting} minutes`,
        html:
          `<p>No delivery rider accepted order #${orderId} (${escapeHtml(route)}) within ` +
          `${minutesWaiting} minutes of dispatch.</p>` +
          `<p>The food is prepared and waiting. <strong>Assign a rider by hand</strong> from the ` +
          `panel — only online riders are shown.</p>` +
          `<p><a href="${orderUrl(orderId)}">Open the order</a></p>`,
      }),
      sms: () =>
        `Order #${orderId} has NO rider after ${minutesWaiting} min (${route}). Assign one manually.\n${orderUrl(orderId)}`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsNoRider ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

/** An order was auto-cancelled. Whether the money went back is the headline. */
async function notifyAdminsOrderCancelled({ orderId, shop, refunded, amount }) {
  try {
    let money = "Cash order — nothing to refund.";
    if (refunded === true) money = `₹${amount} refund submitted to PhonePe.`;
    else if (refunded === false) money = `₹${amount} was paid online and the REFUND FAILED — refund it by hand.`;

    const title = `Order #${orderId} auto-cancelled`;
    const body = `${shop} never accepted it. ${money}`;

    return await fanOut({
      channels: escalationChannels(),
      mailEnvVar: "ORDER_ALERT_EMAILS",
      // A failed refund is the one case a human must act on, so it gets its own
      // icon rather than being buried in body text the bell truncates.
      notification: {
        title,
        body,
        icon: refunded === false ? "error" : "cancel",
        refOrderId: orderId,
      },
      event: "order.cancelled",
      payload: { order_id: orderId, shop, refunded, amount, title, body },
      mail: () => ({
        subject: `❌ Order #${orderId} auto-cancelled`,
        html:
          `<p><strong>${escapeHtml(shop)}</strong> never accepted order #${orderId}, so it was ` +
          `cancelled automatically.</p><p>${escapeHtml(money)}</p>` +
          `<p><a href="${orderUrl(orderId)}">Open the order</a></p>`,
      }),
      sms: () => `Order #${orderId} auto-cancelled. ${shop} never accepted it. ${money}\n${orderUrl(orderId)}`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsOrderCancelled ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

/**
 * A payment whose amount does not match what we quoted.
 *
 * Should be impossible: we set the amount when we create the order at the
 * gateway and the customer cannot change it. So this firing means either a bug
 * on our side or an anomaly on theirs, and in both cases a human has to look
 * before anybody is given food.
 */
async function notifyAdminsPaymentMismatch({ merchantTxnId, quoted, collected, settled }) {
  try {
    const title = "Payment amount mismatch";
    const body =
      `Txn ${merchantTxnId}: quoted Rs${quoted}, gateway holds Rs${collected}. ` +
      (settled ? "Order created anyway (customer paid more)." : "NO order created.");

    return await fanOut({
      channels: escalationChannels(),
      mailEnvVar: "ORDER_ALERT_EMAILS",
      notification: { title, body, icon: "warning" },
      event: "payment.mismatch",
      payload: { merchant_txn_id: merchantTxnId, quoted, collected, settled, title, body },
      mail: () => ({
        subject: `⚠️ Payment amount mismatch on ${merchantTxnId}`,
        html:
          `<p>The gateway reports <strong>Rs${escapeHtml(String(collected))}</strong> for ` +
          `transaction <code>${escapeHtml(merchantTxnId)}</code>, but we quoted ` +
          `<strong>Rs${escapeHtml(String(quoted))}</strong>.</p>` +
          (settled
            ? "<p>The customer paid at least the quoted amount, so the order was created. " +
              "The difference needs refunding.</p>"
            : '<p style="color:#b00020"><strong>No order was created.</strong> The customer ' +
              "has been charged less than the order is worth — refund them or take the " +
              "difference before releasing any food.</p>"),
      }),
      sms: () => `Payment mismatch ${merchantTxnId}: quoted Rs${quoted}, got Rs${collected}.`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsPaymentMismatch ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

// How long a stuck-payment alert suppresses the next identical one.
const STUCK_REALERT_HOURS = Number(process.env.PAYMENT_STUCK_REALERT_HOURS || 12);

// The part of the title that does not vary with the count, so a pile that grows
// from 3 to 4 is still recognised as the same standing alert.
const STUCK_TITLE_SUFFIX = "payment(s) charged with no order";

/**
 * Has this alert already been raised inside the re-alert window?
 *
 * The caller (util/paymentSweeper.js) only alerts when the count CHANGES, but
 * it tracks that in a process-local variable — so every restart resets it and
 * re-alerts for the same payments. On a host that sleeps when idle that is not
 * an edge case: it produced 70 identical notifications for the same 3 payments,
 * which is how a real alert gets trained into background noise.
 *
 * Deduping on the durable rows instead means the window survives restarts,
 * redeploys and multiple instances. Failure here returns false — a duplicate
 * notification is a far better outcome than a silently swallowed one.
 */
async function stuckAlertedRecently() {
  try {
    const found = await UserNotification.findOne({
      attributes: ["notif_id"],
      where: {
        title: { [Op.like]: `%${STUCK_TITLE_SUFFIX}` },
        created_at: { [Op.gt]: new Date(Date.now() - STUCK_REALERT_HOURS * 3600000) },
      },
    });
    return found != null;
  } catch (err) {
    console.log("MFB-error-logs ~ stuckAlertedRecently ~", err.message);
    return false;
  }
}

/**
 * Payments the reconciliation sweep has given up on.
 *
 * This is the worst state the system can produce: the customer has been charged
 * and no order exists. It used to be a console.log, which on a hosted box means
 * nobody will ever see it.
 *
 * Rate-limited to one alert per PAYMENT_STUCK_REALERT_HOURS — see
 * stuckAlertedRecently. The payments do not go away when the alert is
 * suppressed; they still need a human at store_payment_intents.
 */
async function notifyAdminsPaymentsStuck({ count, hours }) {
  try {
    if (await stuckAlertedRecently()) {
      console.log(
        `MFB ~ ${count} payment(s) still stuck — alert suppressed, one was already ` +
          `raised in the last ${STUCK_REALERT_HOURS}h.`
      );
      return {
        panel: 0, realtime: 0, email: null, sms: null,
        channels: [], suppressed: "already_alerted",
      };
    }
    const title = `${count} ${STUCK_TITLE_SUFFIX}`;
    const body =
      `Stuck PENDING for over ${hours}h and no longer polled. ` +
      "Each one may be a customer charged for nothing.";

    return await fanOut({
      channels: escalationChannels(),
      mailEnvVar: "ORDER_ALERT_EMAILS",
      notification: { title, body, icon: "error" },
      event: "payment.stuck",
      payload: { count, hours, title, body },
      mail: () => ({
        subject: `⚠️ ${count} payment(s) taken with no order created`,
        html:
          `<p><strong>${count}</strong> payment(s) have been PENDING for more than ` +
          `${hours} hours and are no longer being polled.</p>` +
          "<p>Each is potentially a customer who paid and received nothing. Review " +
          "<code>store_payment_intents</code> where <code>status = 'PENDING'</code>.</p>",
      }),
      sms: () => `${count} payment(s) charged with no order. Check store_payment_intents.`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsPaymentsStuck ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

/** A refund the gateway has rejected. The customer is still out of pocket. */
async function notifyAdminsRefundFailed({ merchantRefundId, orderId, amount, reason }) {
  try {
    const title = `Refund failed for order #${orderId}`;
    const body = `Rs${amount} could not be refunded (${reason}). The customer is still owed it.`;

    return await fanOut({
      channels: escalationChannels(),
      mailEnvVar: "ORDER_ALERT_EMAILS",
      notification: { title, body, icon: "error", refOrderId: orderId },
      event: "refund.failed",
      payload: { merchant_refund_id: merchantRefundId, order_id: orderId, amount, reason, title, body },
      mail: () => ({
        subject: `⚠️ Refund failed for order #${orderId}`,
        html:
          `<p>Refund <code>${escapeHtml(merchantRefundId)}</code> of ` +
          `<strong>Rs${escapeHtml(String(amount))}</strong> for order #${orderId} was ` +
          `rejected by the gateway: ${escapeHtml(String(reason))}.</p>` +
          "<p>The customer has not got their money back. This has to be settled by hand.</p>" +
          `<p><a href="${orderUrl(orderId)}">Open the order</a></p>`,
      }),
      sms: () => `Refund FAILED order #${orderId} Rs${amount}: ${reason}`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ notifyAdminsRefundFailed ~", err.message);
    return { panel: 0, realtime: 0, email: null, sms: null, channels: [], error: err.message };
  }
}

module.exports = {
  notifyAdminsRiderApplied,
  notifyAdminsOrderStuck,
  notifyAdminsOrderFinalWarning,
  notifyAdminsNoRider,
  notifyAdminsOrderCancelled,
  notifyAdminsPaymentMismatch,
  notifyAdminsPaymentsStuck,
  notifyAdminsRefundFailed,
  // Exported for tests: these are pure decisions worth testing without a
  // database or a live SMTP host behind them.
  _enabledChannels: enabledChannels,
  _escalationChannels: escalationChannels,
  _mailRecipients: mailRecipients,
  ADMIN_ROLES,
};
