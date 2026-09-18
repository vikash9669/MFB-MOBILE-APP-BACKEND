const { Op, fn, col } = require("sequelize");
const { DeliveryOrder, DeliveryPartner } = require("../models");
const { num } = require("../util/delivery");
const { accruedToday, paidBetween } = require("../util/presence/onlinePay");
const { istDateOf, istAddDays } = require("../util/presence/config");

// Returns the [start, end) window and a matching set of chart buckets for a
// requested period.
const windowFor = (period) => {
  const now = new Date();
  const start = new Date(now);
  if (period === "week") {
    start.setDate(now.getDate() - 6);
  } else if (period === "month") {
    start.setDate(now.getDate() - 29);
  } else if (period === "year") {
    start.setMonth(now.getMonth() - 11);
  }
  start.setHours(0, 0, 0, 0);
  return { start, now };
};

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// Builds a 7-bar chart of the last 7 days' earnings (used for all periods).
const dailyBars = async (dpId) => {
  const start = new Date();
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);

  const rows = await DeliveryOrder.findAll({
    where: { dp_id: dpId, status: "delivered", delivered_at: { [Op.gte]: start } },
    attributes: [
      [fn("DATE", col("delivered_at")), "day"],
      [fn("COALESCE", fn("SUM", col("earn_total")), 0), "total"],
    ],
    group: [fn("DATE", col("delivered_at"))],
    raw: true,
  });
  const byDay = {};
  rows.forEach((r) => {
    byDay[r.day] = num(r.total);
  });

  const bars = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    bars.push({ label: DAY_LABELS[d.getDay()], value: byDay[key] || 0 });
  }
  const max = Math.max(1, ...bars.map((b) => b.value));
  return bars.map((b) => ({ ...b, hi: b.value === max && b.value > 0 }));
};

// GET /delivery/earnings?period=today|week|month|year
exports.getEarnings = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const period = ["today", "week", "month", "year"].includes(req.query.period)
      ? req.query.period
      : "today";
    const { start } = windowFor(period);

    const rows = await DeliveryOrder.findAll({
      where: { dp_id: dpId, status: "delivered", delivered_at: { [Op.gte]: start } },
      attributes: [
        [fn("COUNT", col("do_id")), "orders"],
        [fn("COALESCE", fn("SUM", col("distance_km")), 0), "distance"],
        [fn("COALESCE", fn("SUM", col("earn_base")), 0), "base"],
        [fn("COALESCE", fn("SUM", col("earn_distance")), 0), "distance_pay"],
        [fn("COALESCE", fn("SUM", col("earn_surge")), 0), "surge"],
        [fn("COALESCE", fn("SUM", col("earn_tip")), 0), "tip"],
        [fn("COALESCE", fn("SUM", col("earn_total")), 0), "total"],
      ],
      raw: true,
    });
    const r = rows[0] || {};
    const partner = await DeliveryPartner.findByPk(dpId);

    // Online pay for the same period: what has been credited for past days,
    // plus today's accrued time (credited after midnight). ₹/hour online is
    // part of what a rider earns, alongside deliveries — RIDER_ONLINE_PAY.md.
    const today = istDateOf(Date.now());
    const fromDate = istDateOf(start.getTime());
    const yesterday = istAddDays(today, -1);
    const [paid, accrued] = await Promise.all([
      fromDate <= yesterday ? paidBetween(dpId, fromDate, yesterday).catch(() => null) : null,
      accruedToday(dpId).catch(() => null),
    ]);
    const onlineTime = Math.round(((paid?.amount ?? 0) + (accrued?.amount ?? 0)) * 100) / 100;
    const onlineMin = (paid?.online_min ?? 0) + (accrued?.online_min ?? 0);

    res.json({
      period,
      total: Math.round((num(r.total) + onlineTime) * 100) / 100,
      orders: num(r.orders),
      distance_km: num(r.distance),
      online_min: onlineMin,
      breakdown: {
        base: num(r.base),
        distance: num(r.distance_pay),
        surge: num(r.surge),
        tip: num(r.tip),
        online_time: onlineTime,
      },
      wallet_balance: partner ? num(partner.dp_wallet_balance) : 0,
      chart: await dailyBars(dpId),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getEarnings ~ err:", err);
    res.status(500).json({ message: "Failed to load earnings" });
  }
};
