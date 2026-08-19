// Delivery notification service — the single entry point for raising a partner
// alert. It (1) persists a row in store_delivery_notifications so the in-app
// feed and unread badge update, and (2) best-effort pushes it to the partner's
// registered devices via FCM, pruning any tokens FCM reports as dead.
//
// Callers should never await this in a way that blocks the response path; a
// failed/absent push must never break the underlying action (accept, deliver,
// withdraw, …).
const { DeliveryNotification, DeliveryDevice } = require("../models");
const { sendToTokens } = require("./fcm");

// Creates the notification row, then fans out a push. Returns the created row.
const notifyPartner = async (dpId, { category, icon, title, body, data, call, ttlSec } = {}) => {
  const notif = await DeliveryNotification.create({
    dp_id: dpId,
    category: category || "system",
    icon: icon || null,
    title,
    body: body || null,
    is_read: false,
  });

  // Push out-of-band; swallow every error so the caller's flow is unaffected.
  // `call` turns this into a data-only, ringing, full-screen alert rather than
  // a tray notification — used for delivery offers, which expire.
  pushToDevices(dpId, {
    title,
    body: body || "",
    call: Boolean(call),
    ttlSec,
    data: { ...(data || {}), notif_id: notif.notif_id, category: category || "system" },
  }).catch((err) => console.log("MFB-error-logs ~ notifyPartner push ~ err:", err.message));

  return notif;
};

// Sends to every device the partner has registered and deletes dead tokens.
const pushToDevices = async (dpId, message) => {
  const devices = await DeliveryDevice.findAll({ where: { dp_id: dpId } });
  if (devices.length === 0) {
    return;
  }
  const tokens = devices.map((d) => d.token);
  const { dead } = await sendToTokens(tokens, message);
  if (dead.length) {
    await DeliveryDevice.destroy({ where: { dp_id: dpId, token: dead } });
  }
};

module.exports = { notifyPartner };
