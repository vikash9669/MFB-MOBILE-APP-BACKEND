const { DeliveryNotification } = require("../models");

const serializeNotif = (n) => ({
  id: n.notif_id,
  category: n.category,
  icon: n.icon,
  title: n.title,
  body: n.body,
  is_read: !!n.is_read,
  created_at: n.created_at,
});

// GET /delivery/notifications?filter=all|orders|payments|bonuses|system
exports.list = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const filter = req.query.filter;
    const where = { dp_id: dpId };
    if (["orders", "payments", "bonuses", "system"].includes(filter)) {
      where.category = filter;
    }

    const items = await DeliveryNotification.findAll({
      where,
      order: [["created_at", "DESC"]],
      limit: 50,
    });
    const unread = await DeliveryNotification.count({
      where: { dp_id: dpId, is_read: false },
    });

    res.json({ unread, notifications: items.map(serializeNotif) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery notifications list ~ err:", err);
    res.status(500).json({ message: "Failed to load notifications" });
  }
};

// GET /delivery/notifications/unread-count — lightweight badge poll.
exports.unreadCount = async (req, res) => {
  try {
    const unread = await DeliveryNotification.count({
      where: { dp_id: req.user.dp_id, is_read: false },
    });
    res.json({ unread });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery unreadCount ~ err:", err);
    res.status(500).json({ message: "Failed to load unread count" });
  }
};

// POST /delivery/notifications/read-all — mark every alert as read.
exports.markAllRead = async (req, res) => {
  try {
    await DeliveryNotification.update(
      { is_read: true },
      { where: { dp_id: req.user.dp_id, is_read: false } }
    );
    res.json({ message: "All notifications marked read" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery markAllRead ~ err:", err);
    res.status(500).json({ message: "Failed to update notifications" });
  }
};

// POST /delivery/notifications/:id/read — mark a single alert as read.
exports.markRead = async (req, res) => {
  try {
    await DeliveryNotification.update(
      { is_read: true },
      { where: { notif_id: req.params.id, dp_id: req.user.dp_id } }
    );
    res.json({ message: "Notification marked read" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery markRead ~ err:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
};
