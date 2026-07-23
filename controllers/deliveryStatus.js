const { Op, fn, col } = require("sequelize");
const {
  DeliveryPartner,
  DeliveryOrder,
  DeliveryShift,
} = require("../models");
const { num, serializePartner } = require("../util/delivery");

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Aggregates today's delivered-order stats for a partner.
const todayStats = async (dpId) => {
  const rows = await DeliveryOrder.findAll({
    where: {
      dp_id: dpId,
      status: "delivered",
      delivered_at: { [Op.gte]: startOfToday() },
    },
    attributes: [
      [fn("COUNT", col("do_id")), "orders"],
      [fn("COALESCE", fn("SUM", col("earn_total")), 0), "earnings"],
      [fn("COALESCE", fn("SUM", col("distance_km")), 0), "distance"],
    ],
    raw: true,
  });
  const r = rows[0] || {};
  return {
    orders: num(r.orders),
    earnings: num(r.earnings),
    distance: num(r.distance),
  };
};

// GET /delivery/home/summary — everything the Home screen needs in one call.
exports.getSummary = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }

    const stats = await todayStats(partner.dp_id);

    // Active shift (if any) for the "You're online" banner.
    const activeShift = await DeliveryShift.findOne({
      where: { dp_id: partner.dp_id, status: "active" },
    });

    // Is there a job currently in progress (accepted / picked up)?
    const activeOrder = await DeliveryOrder.findOne({
      where: { dp_id: partner.dp_id, status: { [Op.in]: ["accepted", "picked_up"] } },
      order: [["accepted_at", "DESC"]],
    });

    // Simple incentive model: 13 orders unlocks a ₹150 bonus.
    const target = 13;
    const bonus = 150;

    res.json({
      partner: serializePartner(partner),
      online: !!partner.dp_online,
      today: stats,
      score: num(partner.dp_rating),
      incentive: {
        orders_done: stats.orders,
        orders_target: target,
        bonus_amount: bonus,
        progress: Math.min(1, target ? stats.orders / target : 0),
      },
      shift: activeShift
        ? {
            id: activeShift.shift_id,
            start_time: activeShift.start_time,
            end_time: activeShift.end_time,
            worked_min: num(activeShift.worked_min),
            label: activeShift.label,
          }
        : null,
      active_order_id: activeOrder ? activeOrder.do_id : null,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getSummary ~ err:", err);
    res.status(500).json({ message: "Failed to load home summary", err });
  }
};

// POST /delivery/status/online — go online / offline.
exports.setOnline = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    const online = req.body.online === true || req.body.online === "true";
    await partner.update({ dp_online: online });
    res.json({ message: online ? "You're online" : "You're offline", online });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery setOnline ~ err:", err);
    res.status(500).json({ message: "Failed to update status", err });
  }
};

// POST /delivery/status/location — push the partner's live GPS position.
exports.updateLocation = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ message: "lat and lng are required" });
    }
    await DeliveryPartner.update(
      { dp_lat: lat, dp_lng: lng },
      { where: { dp_id: req.user.dp_id } }
    );
    res.json({ message: "Location updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery updateLocation ~ err:", err);
    res.status(500).json({ message: "Failed to update location", err });
  }
};
