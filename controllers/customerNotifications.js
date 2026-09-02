// Customer notification-centre + push-device endpoints (store_user_*).
// All partner-facing routes are keyed by the signed-in customer (req.user.user_id).
const { UserNotification, UserDevice } = require("../models");
const { notifyUser } = require("../util/customerNotify");

const CATEGORIES = ["orders", "offers", "wallet", "system"];

const serializeNotif = (n) => ({
  id: n.notif_id,
  category: n.category,
  icon: n.icon,
  title: n.title,
  body: n.body,
  order_id: n.ref_order_id,
  image: n.image,
  vendor_id: n.ref_business_user_id,
  promo_code: n.ref_promo_code,
  is_read: !!n.is_read,
  created_at: n.created_at,
});

// GET /user/notifications?filter=all|orders|offers|wallet|system
exports.list = async (req, res) => {
  try {
    const userId = req.user.user_id;
    const where = { user_id: userId };
    if (CATEGORIES.includes(req.query.filter)) {
      where.category = req.query.filter;
    }
    const items = await UserNotification.findAll({
      where,
      order: [["created_at", "DESC"]],
      limit: 50,
    });
    const unread = await UserNotification.count({
      where: { user_id: userId, is_read: false },
    });
    res.json({ unread, notifications: items.map(serializeNotif) });
  } catch (err) {
    console.log("MFB-error-logs ~ customer notifications list ~ err:", err);
    res.status(500).json({ message: "Failed to load notifications" });
  }
};

// GET /user/notifications/unread-count — lightweight badge poll.
exports.unreadCount = async (req, res) => {
  try {
    const unread = await UserNotification.count({
      where: { user_id: req.user.user_id, is_read: false },
    });
    res.json({ unread });
  } catch (err) {
    console.log("MFB-error-logs ~ customer unreadCount ~ err:", err);
    res.status(500).json({ message: "Failed to load unread count" });
  }
};

// POST /user/notifications/read-all
exports.markAllRead = async (req, res) => {
  try {
    await UserNotification.update(
      { is_read: true },
      { where: { user_id: req.user.user_id, is_read: false } }
    );
    res.json({ message: "All notifications marked read" });
  } catch (err) {
    console.log("MFB-error-logs ~ customer markAllRead ~ err:", err);
    res.status(500).json({ message: "Failed to update notifications" });
  }
};

// POST /user/notifications/:id/read
exports.markRead = async (req, res) => {
  try {
    await UserNotification.update(
      { is_read: true },
      { where: { notif_id: req.params.id, user_id: req.user.user_id } }
    );
    res.json({ message: "Notification marked read" });
  } catch (err) {
    console.log("MFB-error-logs ~ customer markRead ~ err:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
};

// POST /user/devices — register (or refresh) an FCM token for this customer.
// Tokens are globally unique: reassigned to the current customer if the device
// was previously used by another account (shared device / reinstall).
exports.registerDevice = async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { token, platform } = req.body;
    if (!token) {
      return res.status(400).json({ message: "Missing device token" });
    }
    const existing = await UserDevice.findOne({ where: { token } });
    if (existing) {
      await existing.update({
        user_id: userId,
        platform: platform || existing.platform,
        last_seen: new Date(),
      });
    } else {
      await UserDevice.create({
        user_id: userId,
        token,
        platform: platform || "android",
        last_seen: new Date(),
      });
    }
    res.json({ message: "Device registered" });
  } catch (err) {
    console.log("MFB-error-logs ~ customer device register ~ err:", err);
    res.status(500).json({ message: "Failed to register device" });
  }
};

// DELETE /user/devices — unregister a token (logout / opt-out).
exports.unregisterDevice = async (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    if (!token) {
      return res.status(400).json({ message: "Missing device token" });
    }
    await UserDevice.destroy({ where: { token, user_id: req.user.user_id } });
    res.json({ message: "Device unregistered" });
  } catch (err) {
    console.log("MFB-error-logs ~ customer device unregister ~ err:", err);
    res.status(500).json({ message: "Failed to unregister device" });
  }
};

// POST /notify/push — INTERNAL. Lets a trusted system (the order/admin backend)
// push a notification to a customer. Guarded by requireAdmin (ADMIN_API_KEY).
// body: { user_id, title, body?, category?, order_id? }
exports.adminPush = async (req, res) => {
  try {
    const { user_id, title, body, category, icon, order_id } = req.body;
    if (!user_id || !title) {
      return res.status(400).json({ message: "user_id and title are required" });
    }
    const notif = await notifyUser(user_id, {
      category: CATEGORIES.includes(category) ? category : "orders",
      icon: icon || "notifications",
      title,
      body,
      refOrderId: order_id || null,
    });
    res.json({ message: "Pushed", notif_id: notif.notif_id });
  } catch (err) {
    console.log("MFB-error-logs ~ customer adminPush ~ err:", err);
    res.status(500).json({ message: "Failed to push notification" });
  }
};
