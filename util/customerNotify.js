// Customer notification service — the single entry point for raising a
// customer-app alert. It (1) persists a row in store_user_notifications so the
// in-app feed + unread badge update, and (2) best-effort pushes it to the
// customer's registered devices via FCM (reusing util/fcm.js), pruning any
// tokens FCM reports as dead.
//
// Never await this on the response path in a way that can fail the underlying
// action (placing an order, etc.) — a missing/failed push must be harmless.
const { UserNotification, UserDevice } = require("../models");
const { sendToTokens } = require("./fcm");

// Creates the notification row, then fans out a push. Returns the created row.
const notifyUser = async (userId, { category, icon, title, body, data, refOrderId } = {}) => {
  const notif = await UserNotification.create({
    user_id: userId,
    category: category || "system",
    icon: icon || null,
    title,
    body: body || null,
    ref_order_id: refOrderId || null,
    is_read: false,
  });

  pushToDevices(userId, {
    title,
    body: body || "",
    data: {
      ...(data || {}),
      notif_id: notif.notif_id,
      category: category || "system",
      ...(refOrderId ? { order_id: refOrderId } : {}),
    },
  }).catch((err) => console.log("MFB-error-logs ~ notifyUser push ~ err:", err.message));

  return notif;
};

// Sends to every device the customer has registered and deletes dead tokens.
const pushToDevices = async (userId, message) => {
  const devices = await UserDevice.findAll({ where: { user_id: userId } });
  if (devices.length === 0) {
    return;
  }
  const tokens = devices.map((d) => d.token);
  const { dead } = await sendToTokens(tokens, message);
  if (dead.length) {
    await UserDevice.destroy({ where: { user_id: userId, token: dead } });
  }
};

module.exports = { notifyUser };
