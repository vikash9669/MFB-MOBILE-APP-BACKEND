// The panel's own notification feed.
//
// Same table as the customer feed (store_user_notifications) because admins are
// store_users rows like everyone else, and a row is scoped by user_id — an
// admin's notifications and a customer's can no more mix than two customers'
// can. What differs is the reader: this one is keyed off req.panel.user_id (the
// panel JWT) rather than req.user.user_id (the customer app token), and it
// exposes ref_partner_id so a rider alert can deep-link to the application.
//
// Deliberately a separate controller rather than a branch inside
// controllers/customerNotifications.js: that file serves the customer app, and
// a shared handler reading whichever of two auth shapes happens to be present
// is exactly how one portal ends up able to read another's rows.
const { UserNotification } = require("../../models");

const serialize = (n) => ({
  id: n.notif_id,
  category: n.category,
  icon: n.icon,
  title: n.title,
  body: n.body,
  order_id: n.ref_order_id,
  partner_id: n.ref_partner_id,
  is_read: !!n.is_read,
  created_at: n.created_at,
});

// GET /admin/notifications
exports.list = async (req, res) => {
  try {
    const userId = req.panel.user_id;
    const items = await UserNotification.findAll({
      where: { user_id: userId },
      order: [["created_at", "DESC"]],
      limit: 50,
    });
    const unread = await UserNotification.count({
      where: { user_id: userId, is_read: false },
    });
    res.json({ unread, notifications: items.map(serialize) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin notifications list ~ err:", err);
    res.status(500).json({ message: "Failed to load notifications" });
  }
};

// GET /admin/notifications/unread-count — the badge.
exports.unreadCount = async (req, res) => {
  try {
    const unread = await UserNotification.count({
      where: { user_id: req.panel.user_id, is_read: false },
    });
    res.json({ unread });
  } catch (err) {
    console.log("MFB-error-logs ~ admin unreadCount ~ err:", err);
    res.status(500).json({ message: "Failed to load unread count" });
  }
};

// POST /admin/notifications/read-all
exports.markAllRead = async (req, res) => {
  try {
    await UserNotification.update(
      { is_read: true },
      { where: { user_id: req.panel.user_id, is_read: false } }
    );
    res.json({ message: "All notifications marked read" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin markAllRead ~ err:", err);
    res.status(500).json({ message: "Failed to update notifications" });
  }
};

// POST /admin/notifications/:id/read
//
// The user_id in the WHERE is not decoration: without it any admin could mark
// any row in the table read, including a customer's.
exports.markRead = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ message: "Invalid notification" });
    }
    await UserNotification.update(
      { is_read: true },
      { where: { notif_id: id, user_id: req.panel.user_id } }
    );
    res.json({ message: "Notification marked read" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin markRead ~ err:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
};
