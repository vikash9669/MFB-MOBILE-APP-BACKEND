// Dashboard — the React equivalent of administration/Admin::Index.
const { Op, fn, col, literal } = require("sequelize");
const { StoreOrders, User, Business, Product } = require("../../models");
const { VENDOR_ROLE, RIDER_ROLE } = require("../../middlewares/verifyAdmin");

// store_orders.order_status, from the column comment on the table:
// 0 Received, 1 Processed, 2 Vendor, 3 Ready to Ship, 4 On the Way,
// 5 Delivered, 6 Cancelled.
const STATUS_LABELS = [
  "Received",
  "Processed",
  "Vendor",
  "Ready to Ship",
  "On the Way",
  "Delivered",
  "Cancelled",
];

const CUSTOMER_ROLE = 12;
const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const num = (v) => Number(v || 0);

// GET /admin/dashboard
exports.summary = async (req, res) => {
  try {
    const today = startOfDay();
    const monthStart = new Date();
    monthStart.setDate(monthStart.getDate() - 29);
    monthStart.setHours(0, 0, 0, 0);

    const revenueWhere = { order_status: { [Op.notIn]: [6] } };

    const [
      ordersToday,
      revenueToday,
      ordersTotal,
      revenueTotal,
      customers,
      vendors,
      riders,
      products,
      byStatus,
      recent,
      trend,
    ] = await Promise.all([
      StoreOrders.count({ where: { order_received_time: { [Op.gte]: today } } }),
      StoreOrders.sum("order_amount", {
        where: { ...revenueWhere, order_received_time: { [Op.gte]: today } },
      }),
      StoreOrders.count(),
      StoreOrders.sum("order_amount", { where: revenueWhere }),
      User.count({ where: { user_role: CUSTOMER_ROLE } }),
      User.count({ where: { user_role: VENDOR_ROLE } }),
      User.count({ where: { user_role: RIDER_ROLE } }),
      Product.count(),
      StoreOrders.findAll({
        attributes: ["order_status", [fn("COUNT", col("order_id")), "count"]],
        group: ["order_status"],
        raw: true,
      }),
      StoreOrders.findAll({
        attributes: [
          "order_id",
          "customer_id",
          "vendor_id",
          "order_amount",
          "order_status",
          "order_payment_type",
          "order_received_time",
        ],
        order: [["order_id", "DESC"]],
        limit: 8,
        raw: true,
      }),
      StoreOrders.findAll({
        attributes: [
          [fn("DATE", col("order_received_time")), "day"],
          [fn("COUNT", col("order_id")), "orders"],
          [fn("COALESCE", fn("SUM", col("order_amount")), 0), "revenue"],
        ],
        where: { order_received_time: { [Op.gte]: monthStart } },
        group: [literal("day")],
        order: [literal("day ASC")],
        raw: true,
      }),
    ]);

    // Attach names to the recent-order list without N+1 queries.
    const ids = [...new Set(recent.flatMap((o) => [o.customer_id, o.vendor_id]))];
    const people = ids.length
      ? await User.findAll({
          where: { user_id: ids },
          attributes: ["user_id", "user_name"],
          raw: true,
        })
      : [];
    const nameById = Object.fromEntries(people.map((p) => [p.user_id, p.user_name]));
    const businesses = await Business.findAll({
      where: { user_id: recent.map((o) => o.vendor_id) },
      attributes: ["user_id", "business_name"],
      raw: true,
    });
    const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));

    res.json({
      cards: {
        orders_today: num(ordersToday),
        revenue_today: num(revenueToday),
        orders_total: num(ordersTotal),
        revenue_total: num(revenueTotal),
        customers: num(customers),
        vendors: num(vendors),
        riders: num(riders),
        products: num(products),
      },
      by_status: STATUS_LABELS.map((label, i) => ({
        status: i,
        label,
        count: num(byStatus.find((s) => Number(s.order_status) === i)?.count),
      })),
      trend: trend.map((t) => ({
        day: t.day,
        orders: num(t.orders),
        revenue: num(t.revenue),
      })),
      recent_orders: recent.map((o) => ({
        order_id: o.order_id,
        customer: nameById[o.customer_id] || `#${o.customer_id}`,
        vendor: bizById[o.vendor_id] || nameById[o.vendor_id] || `#${o.vendor_id}`,
        amount: num(o.order_amount),
        status: Number(o.order_status),
        status_label: STATUS_LABELS[Number(o.order_status)] || "Unknown",
        payment_type: o.order_payment_type,
        placed_at: o.order_received_time,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin dashboard ~ err:", err);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
};

exports.STATUS_LABELS = STATUS_LABELS;
