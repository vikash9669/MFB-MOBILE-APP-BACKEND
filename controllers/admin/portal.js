// Vendor and rider portals — the React equivalent of administration/Vendor and
// administration/Rider.
//
// The PHP panel gave each role its own dashboard over the *same* orders table,
// differing only in the WHERE clause (Orders_Model::GetDailyOrdersList and
// GetOrdersList): a vendor sees orders for their store, a rider sees orders
// assigned to them. That scoping is reproduced here, derived from the token —
// never from a client-supplied id, so one vendor cannot read another's orders.
const { Op, fn, col, literal, QueryTypes } = require("sequelize");
// Raw queries for the delivery side: those columns are added by a migration
// that may not have run, and naming them on a model would break every SELECT
// until it does.
const sequelize = require("../../util/database");
const {
  StoreOrders,
  StoreOrderDetails,
  Product,
  User,
  Business,
  Address,
} = require("../../models");
const { STATUS_LABELS } = require("./dashboard");
// A status write from this portal must do what the admin screen's does — same
// log row, same cashback settlement.
const { logStatus, settleCashback, CASHBACK_SETTLE_STATUS } = require("./orders");
const { acceptOrder, cancelOrder } = require("../../util/orderLifecycle");
// Read only for the window figures the vendor screen counts down against, so
// the deadline shown to a vendor is the same one the sweeper enforces.
const acceptWindow = require("../../util/orderAcceptSweeper");
const { summaryForPartner } = require("../../util/ratings");

const num = (v) => Number(v || 0);
const label = (s) => STATUS_LABELS[Number(s)] || "Unknown";

// Index into STATUS_LABELS. Named because the dispatch trigger hangs off it and
// a bare `3` in that condition is the kind of thing that silently rots when the
// label list changes.
const READY_TO_SHIP = STATUS_LABELS.indexOf("Ready to Ship");

/**
 * How many line items each order has, in one query rather than N.
 *
 * The acceptance screen shows "3 items" per card; fetching the details table
 * per row would be 50 queries to render one list.
 */
async function itemCounts(orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await StoreOrderDetails.findAll({
    where: { order_id: orderIds },
    attributes: ["order_id", [fn("COUNT", col("order_detail_id")), "n"]],
    group: ["order_id"],
    raw: true,
  });
  return new Map(rows.map((r) => [r.order_id, Number(r.n)]));
}

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

/** The scope filter for whoever is signed in. Admins see everything. */
function scopeWhere(panel) {
  if (panel.portal === "vendor") return { vendor_id: panel.user_id };
  if (panel.portal === "rider") return { rider_id: panel.user_id };
  return {};
}

// Decorates orders with the names each portal shows.
async function decorate(rows) {
  const ids = [
    ...new Set(rows.flatMap((o) => [o.customer_id, o.vendor_id, o.rider_id]).filter(Boolean)),
  ];
  if (ids.length === 0) return rows.map((o) => ({ ...o }));
  const [people, businesses, addresses] = await Promise.all([
    User.findAll({
      where: { user_id: ids },
      attributes: ["user_id", "user_name", "user_phone"],
      raw: true,
    }),
    Business.findAll({
      where: { user_id: ids },
      attributes: ["user_id", "business_name"],
      raw: true,
    }),
    Address.findAll({
      where: { delivery_id: [...new Set(rows.map((o) => o.address_id).filter(Boolean))] },
      attributes: ["delivery_id", "delivery_address", "delivery_landmark", "delivery_phone"],
      raw: true,
    }),
  ]);
  const byId = Object.fromEntries(people.map((p) => [p.user_id, p]));
  const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));
  const addrById = Object.fromEntries(addresses.map((a) => [a.delivery_id, a]));

  return rows.map((o) => ({
    ...o,
    customer_name: byId[o.customer_id]?.user_name ?? null,
    customer_phone: byId[o.customer_id]?.user_phone ?? null,
    vendor_name: bizById[o.vendor_id] ?? byId[o.vendor_id]?.user_name ?? null,
    rider_name: byId[o.rider_id]?.user_name ?? null,
    rider_phone: byId[o.rider_id]?.user_phone ?? null,
    address: addrById[o.address_id] ?? null,
  }));
}

const serialize = (o) => ({
  order_id: o.order_id,
  customer_name: o.customer_name,
  customer_phone: o.customer_phone,
  vendor_id: o.vendor_id,
  vendor_name: o.vendor_name,
  rider_id: o.rider_id,
  rider_name: o.rider_name,
  rider_phone: o.rider_phone,
  amount: num(o.order_amount),
  delivery_charges: num(o.delivery_charges),
  discount: num(o.order_discount),
  payable: num(o.order_amount) + num(o.delivery_charges) - num(o.order_discount),
  payment_type: o.order_payment_type,
  payment_status: Number(o.order_payment_status),
  transaction_id: o.order_transaction_id,
  status: Number(o.order_status),
  status_label: label(o.order_status),
  placed_at: o.order_received_time,
  delivered_at: o.order_delivered_time,
  address: o.address
    ? {
        address: o.address.delivery_address,
        landmark: o.address.delivery_landmark,
        phone: o.address.delivery_phone,
      }
    : null,
});

// GET /admin/portal/dashboard — Vendor::Index / Rider::Index.
// Today's orders plus the headline numbers, scoped to the signed-in user.
exports.dashboard = async (req, res) => {
  try {
    const where = { ...scopeWhere(req.panel) };
    const today = startOfDay();

    const [todayRows, totals, byStatus] = await Promise.all([
      StoreOrders.findAll({
        where: { ...where, order_received_time: { [Op.gte]: today } },
        order: [["order_id", "DESC"]],
        limit: 50,
        raw: true,
      }),
      StoreOrders.findAll({
        attributes: [
          [fn("COUNT", col("order_id")), "orders"],
          [fn("COALESCE", fn("SUM", col("order_amount")), 0), "amount"],
          [fn("COALESCE", fn("SUM", col("delivery_charges")), 0), "delivery"],
        ],
        where: { ...where, order_received_time: { [Op.gte]: today } },
        raw: true,
      }),
      StoreOrders.findAll({
        attributes: ["order_status", [fn("COUNT", col("order_id")), "count"]],
        where,
        group: ["order_status"],
        raw: true,
      }),
    ]);

    const decorated = await decorate(todayRows);
    const t = totals[0] || {};

    res.json({
      portal: req.panel.portal,
      today: {
        orders: num(t.orders),
        amount: num(t.amount),
        delivery: num(t.delivery),
      },
      by_status: STATUS_LABELS.map((l, i) => ({
        status: i,
        label: l,
        count: num(byStatus.find((s) => Number(s.order_status) === i)?.count),
      })),
      orders: decorated.map(serialize),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal dashboard ~ err:", err);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
};

// GET /admin/portal/orders/new?after_id=N
//
// The feed behind the panel's notification bell: orders that arrived since the
// caller last looked, scoped the same way everything else is — a vendor only
// ever learns about their own.
//
// The watermark is order_id, not a timestamp, and deliberately so.
// store_orders.order_received_time is written as `Date.now() + 5.5h` (a manual
// IST shift in util/orders.js), so it does not agree with the server clock and
// a "since this time" query would silently miss or repeat rows. order_id is
// auto-increment, monotonic and immune to all of that.
//
// Called with no after_id it returns no orders, only the current high-water
// mark — so a client opening the panel establishes a baseline instead of being
// shown every order ever placed as "new".
exports.newOrders = async (req, res) => {
  try {
    const where = { ...scopeWhere(req.panel) };

    const [latest] = await StoreOrders.findAll({
      where,
      attributes: [[fn("MAX", col("order_id")), "max_id"]],
      raw: true,
    });
    const latestId = Number(latest?.max_id || 0);

    const afterId = Number(req.query.after_id);
    if (!Number.isInteger(afterId) || afterId <= 0) {
      return res.json({ orders: [], latest_id: latestId, baseline: true });
    }

    const rows = await StoreOrders.findAll({
      where: { ...where, order_id: { [Op.gt]: afterId } },
      order: [["order_id", "DESC"]],
      // A bell is not a backlog viewer. If someone leaves the tab shut for a
      // day they get the newest few plus an accurate count, not 300 rows.
      limit: 20,
      raw: true,
    });

    const decorated = await decorate(rows);

    res.json({
      orders: decorated.map(serialize),
      latest_id: latestId,
      // How many arrived in total, which may exceed what we returned.
      total_new: await StoreOrders.count({
        where: { ...where, order_id: { [Op.gt]: afterId } },
      }),
      baseline: false,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal newOrders ~ err:", err);
    res.status(500).json({ message: "Failed to load new orders" });
  }
};

// GET /admin/portal/orders?status=&from=&to=&page=  — Vendor::Orders / Rider::Orders
exports.orders = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const where = { ...scopeWhere(req.panel) };
    if (req.query.status !== undefined && req.query.status !== "") {
      where.order_status = Number(req.query.status);
    }
    if (req.query.from || req.query.to) {
      where.order_received_time = {};
      if (req.query.from) where.order_received_time[Op.gte] = new Date(`${req.query.from}T00:00:00`);
      if (req.query.to) where.order_received_time[Op.lte] = new Date(`${req.query.to}T23:59:59`);
    }

    const { count, rows } = await StoreOrders.findAndCountAll({
      where,
      order: [["order_id", "DESC"]],
      limit,
      offset: (page - 1) * limit,
      raw: true,
    });

    const decorated = await decorate(rows);
    res.json({
      orders: decorated.map(serialize),
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit),
      status_labels: STATUS_LABELS,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal orders ~ err:", err);
    res.status(500).json({ message: "Failed to load orders" });
  }
};

// GET /admin/portal/reports?from=&to=&status= — Vendor::Reports / Rider::Reports
// Mirrors Orders_Model::GetOrdersSummary, which is scoped the same way.
exports.reports = async (req, res) => {
  try {
    const where = { ...scopeWhere(req.panel) };
    if (req.query.status !== undefined && req.query.status !== "") {
      where.order_status = Number(req.query.status);
    }
    if (req.query.from || req.query.to) {
      where.order_received_time = {};
      if (req.query.from) where.order_received_time[Op.gte] = new Date(`${req.query.from}T00:00:00`);
      if (req.query.to) where.order_received_time[Op.lte] = new Date(`${req.query.to}T23:59:59`);
    }

    const [summary] = await StoreOrders.findAll({
      attributes: [
        [fn("COUNT", col("order_id")), "total_orders"],
        [fn("COALESCE", fn("SUM", col("order_amount")), 0), "total_amount"],
        [fn("COALESCE", fn("SUM", col("delivery_charges")), 0), "total_delivery_charges"],
      ],
      where,
      raw: true,
    });

    const daily = await StoreOrders.findAll({
      attributes: [
        [fn("DATE", col("order_received_time")), "day"],
        [fn("COUNT", col("order_id")), "orders"],
        [fn("COALESCE", fn("SUM", col("order_amount")), 0), "amount"],
      ],
      where,
      group: [literal("day")],
      order: [literal("day ASC")],
      raw: true,
    });

    res.json({
      summary: {
        total_orders: num(summary?.total_orders),
        total_amount: num(summary?.total_amount),
        total_delivery_charges: num(summary?.total_delivery_charges),
      },
      daily: daily.map((d) => ({ day: d.day, orders: num(d.orders), amount: num(d.amount) })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal reports ~ err:", err);
    res.status(500).json({ message: "Failed to build report" });
  }
};

/**
 * Which statuses a vendor may set from their own screens, and from where.
 *
 * Only "Ready to Ship", and only while the food is still in the kitchen. Every
 * other row of STATUS_LABELS belongs to somebody else: leaving "Received" is a
 * prep-time commitment and belongs to accept, "Cancelled" has to refund the
 * customer and tell them why so it belongs to decline, "Vendor" is an admin
 * assigning a rider, and "On the Way" / "Delivered" are the rider's own
 * progress. The panel used to offer a vendor all seven in one dropdown, which
 * meant a vendor could cancel a paid order with no refund and no word to the
 * customer, or mark it delivered from the kitchen. This is the rule; the screen
 * only mirrors it.
 */
function vendorStatusRefusal(currentStatus, target) {
  if (currentStatus === 0) {
    return "Accept or decline this order first — that is what commits a prep time or refunds the customer.";
  }
  if (target !== READY_TO_SHIP) {
    return `A store can only mark an order "${label(READY_TO_SHIP)}". Anything after that is the delivery partner's to set.`;
  }
  if (currentStatus >= READY_TO_SHIP) {
    return "This order has already left the kitchen.";
  }
  return null;
}

// PUT /admin/portal/orders/:id/status — a vendor or rider advancing their own
// order. The scope check is what stops one vendor touching another's order.
exports.updateStatus = async (req, res) => {
  const status = Number(req.body.status);
  if (!Number.isInteger(status) || status < 0 || status >= STATUS_LABELS.length) {
    return res.status(400).json({ message: "Invalid status" });
  }

  // The row, the log entry and the cashback settlement move together or not at
  // all. Dispatch is deliberately outside: it talks to the delivery engine, and
  // an order that is ready must stay ready even if no rider can be found.
  let orderId;
  const transaction = await sequelize.transaction();
  try {
    const order = await StoreOrders.findOne({
      where: { order_id: req.params.id, ...scopeWhere(req.panel) },
      transaction,
    });
    if (order == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    if (req.panel.portal === "vendor") {
      const refusal = vendorStatusRefusal(Number(order.order_status), status);
      if (refusal) {
        await transaction.rollback();
        // 409, not 403: the vendor is allowed here, the order has just moved on
        // (or hasn't started), so the screen refreshes rather than showing a
        // permissions error.
        return res.status(409).json({
          message: refusal,
          status: Number(order.order_status),
          status_label: label(order.order_status),
        });
      }
    }

    const patch = { order_status: status, order_updated_by: req.panel.user_id };
    if (status === 5 && order.order_delivered_time == null) {
      patch.order_delivered_time = new Date();
    }
    await order.update(patch, { transaction });

    // The same trail and the same ledger an admin's status write leaves. Without
    // these, an order driven by the vendor — which is now the normal path —
    // reached "Ready to Ship" with nothing in store_orders_log and its pending
    // cashback never credited.
    await logStatus(order.order_id, req.panel.user_id, status, transaction);
    if (status === CASHBACK_SETTLE_STATUS) {
      await settleCashback(order.order_id, transaction);
    }
    await transaction.commit();
    orderId = order.order_id;
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ portal update status ~ err:", err);
    return res.status(500).json({ message: "Failed to update order" });
  }

  // "Ready to Ship" is the kitchen saying the bag is on the counter, so it is
  // the moment to put a rider on it. Before this, the status dropdown only wrote
  // the row: a vendor could mark an order ready and no rider was ever told,
  // because the only thing that rings a rider is the dispatch engine and nothing
  // here started it. Best-effort — the status change is already committed and
  // must not be reported as failed because dispatch was.
  let dispatched = null;
  if (status === READY_TO_SHIP) {
    try {
      const { dispatchNowForSourceOrder } = require("../../util/deliveryDispatch");
      dispatched = await dispatchNowForSourceOrder(orderId);
    } catch (err) {
      console.log("MFB-error-logs ~ portal dispatch on ready ~ err:", err);
    }
  }

  res.json({
    message: "Order updated",
    status,
    status_label: label(status),
    // Lets the panel say "looking for a rider" instead of leaving the vendor
    // guessing whether marking it ready did anything.
    dispatch: status === READY_TO_SHIP ? { requested: true, do_id: dispatched } : undefined,
  });
};

// GET /admin/portal/orders/pending
// The acceptance queue: orders still at Received, scoped to the caller's portal.
// Drives the vendor's New Orders screen, so it carries everything that screen
// needs to render a countdown without a second round-trip.
exports.pendingOrders = async (req, res) => {
  try {
    const rows = await StoreOrders.findAll({
      where: { ...scopeWhere(req.panel), order_status: 0 },
      order: [["order_id", "DESC"]],
      // The acceptance window is 10 minutes; anything beyond the newest 50 is
      // backlog for the admin screen, not a queue anyone is working through.
      limit: 50,
      raw: true,
    });

    const decorated = await decorate(rows);
    const items = await itemCounts(rows.map((o) => o.order_id));

    res.json({
      orders: decorated.map((o) => ({
        ...serialize(o),
        item_count: items.get(o.order_id) ?? 0,
      })),
      // The screen counts down locally; these tell it against what.
      window: {
        escalate_min: acceptWindow.ESCALATE_MIN,
        cancel_min: acceptWindow.CANCEL_MIN,
        auto_cancel: acceptWindow.AUTO_CANCEL,
      },
      // Sent so the client's clock skew cannot make a countdown lie.
      server_time: Date.now(),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal pendingOrders ~ err:", err);
    res.status(500).json({ message: "Failed to load new orders" });
  }
};

// PUT /admin/portal/orders/:id/accept  { prep_minutes }
// The vendor commits to cooking, and to how long it will take.
exports.acceptOrder = async (req, res) => {
  try {
    // Ownership first: scopeWhere pins a vendor to their own orders, so this
    // 404 is what stops one restaurant accepting another's order.
    const order = await StoreOrders.findOne({
      where: { order_id: req.params.id, ...scopeWhere(req.panel) },
      attributes: ["order_id"],
    });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }

    const result = await acceptOrder({
      orderId: Number(req.params.id),
      prepMinutes: req.body.prep_minutes,
      actor: String(req.panel.user_id),
    });

    if (!result.ok) {
      // 409, not 400: the request was well-formed, somebody else just got there
      // first. The screen uses this to refresh rather than show a form error.
      return res.status(result.alreadyHandled ? 409 : 400).json({
        message: result.reason,
        status: result.status,
      });
    }

    res.json({
      message: `Order accepted — ready in about ${result.prepMinutes} minutes`,
      status: result.status,
      status_label: label(result.status),
      prep_minutes: result.prepMinutes,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal acceptOrder ~ err:", err);
    res.status(500).json({ message: "Failed to accept order" });
  }
};

// PUT /admin/portal/orders/:id/decline  { reason }
// Cancels the order and, if it was paid online, refunds it.
exports.declineOrder = async (req, res) => {
  try {
    const order = await StoreOrders.findOne({
      where: { order_id: req.params.id, ...scopeWhere(req.panel) },
      attributes: ["order_id"],
    });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }

    const reason = String(req.body.reason || "").trim();
    if (reason.length < 3) {
      return res
        .status(400)
        .json({ message: "Please give a reason — the customer is told why." });
    }

    const result = await cancelOrder({
      orderId: Number(req.params.id),
      reason,
      by: req.panel.portal === "vendor" ? "vendor" : "admin",
      actorId: req.panel.user_id,
    });

    if (!result.ok) {
      return res.status(result.alreadyHandled ? 409 : 400).json({
        message: result.reason,
        status: result.status,
      });
    }

    res.json({
      message: "Order declined",
      status: result.status,
      status_label: label(result.status),
      // null for COD, true/false for an online payment.
      refunded: result.refund == null ? null : Boolean(result.refund.accepted),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal declineOrder ~ err:", err);
    res.status(500).json({ message: "Failed to decline order" });
  }
};

// PUT /admin/portal/orders/:id/payment — Rider::updatePayment.
// The PHP version set status 5 (Delivered), stamped the delivery time and
// recorded the transaction id in one call; kept identical.
exports.riderPayment = async (req, res) => {
  try {
    const order = await StoreOrders.findOne({
      where: { order_id: req.params.id, rider_id: req.panel.user_id },
    });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    await order.update({
      order_transaction_id: req.body.transaction_id || order.order_transaction_id,
      order_payment_status: Number(req.body.payment_status) ? 1 : 0,
      order_payment_received: Number(req.body.payment_status) ? 1 : 0,
      order_status: 5,
      order_updated_by: req.panel.user_id,
      order_delivered_time: new Date(),
    });
    res.json({ message: "Payment recorded and order marked delivered" });
  } catch (err) {
    console.log("MFB-error-logs ~ rider payment ~ err:", err);
    res.status(500).json({ message: "Failed to record payment" });
  }
};

// GET /admin/portal/products — Vendor::Products, the vendor's own catalogue.
exports.vendorProducts = async (req, res) => {
  try {
    const where = { product_user_id: req.panel.user_id };
    if (req.query.search) {
      where.product_name = { [Op.like]: `%${String(req.query.search).trim()}%` };
    }
    const rows = await Product.findAll({
      where,
      order: [["product_id", "DESC"]],
      limit: 200,
      raw: true,
    });
    res.json({
      products: rows.map((p) => ({
        product_id: p.product_id,
        name: p.product_name,
        mrp: num(p.product_mrp),
        status: Number(p.product_status ?? 1),
        image: p.product_image || null,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ vendor products ~ err:", err);
    res.status(500).json({ message: "Failed to load products" });
  }
};

// Editing a product now goes through the catalogue controller — PUT
// /admin/portal/products/:id is catalogue.updateProduct, which covers every
// field and the category links instead of just name/MRP/status, and enforces the
// same "is this yours" rule. See routes/admin.js.

// PUT /admin/portal/store — Vendor::storeClose, for the vendor themselves.
// PUT /admin/portal/store  { open } — administration/Vendor::storeClose.
//
// Writes store_users.user_login, the flag the customer app's `isShopOpen`
// actually reads. See people.setStoreOpen for why business_status must not be
// used here.
exports.toggleOwnStore = async (req, res) => {
  try {
    const user = await User.findByPk(req.panel.user_id);
    if (user == null) {
      return res.status(404).json({ message: "Store not found" });
    }
    await user.update({ user_login: Number(req.body.open) ? 1 : 0 });
    res.json({
      message: Number(req.body.open) ? "Store is open" : "Store is closed",
      store_open: Boolean(Number(req.body.open)),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ vendor store toggle ~ err:", err);
    res.status(500).json({ message: "Failed to update store" });
  }
};

/**
 * A panel rider's rating, or null.
 *
 * The panel account (store_users) and the delivery-app partner
 * (store_delivery_partners) are joined only by phone number — see
 * util/riderLink.js. A rider who has a portal login but never onboarded in the
 * app has no ratings, and that is a normal state, not an error.
 */
async function riderRatingFor(user) {
  try {
    const { findPartnerForPanelRider } = require("../../util/riderLink");
    const partner = await findPartnerForPanelRider(user.user_id);
    if (partner == null) return null;
    const summary = await summaryForPartner(partner.dp_id);
    // Nobody has rated them yet — say nothing rather than show a zero.
    if (summary == null || summary.count === 0) return null;
    return { average: summary.average, count: summary.count, breakdown: summary.breakdown };
  } catch (err) {
    console.log("MFB ~ portal ~ riderRating ~", err.message);
    return null;
  }
}

// GET /admin/portal/me — profile plus, for vendors, their store state.
exports.profile = async (req, res) => {
  try {
    const user = await User.findByPk(req.panel.user_id, { raw: true });
    const business =
      req.panel.portal === "vendor"
        ? await Business.findOne({ where: { user_id: req.panel.user_id }, raw: true })
        : null;
    res.json({
      user: {
        user_id: user.user_id,
        name: user.user_name,
        email: user.user_email,
        phone: user.user_phone,
        role: Number(user.user_role),
      },
      // store_open is the switch on the dashboard (store_users.user_login).
      // business_status is onboarding completeness and is read-only here.
      store_open: Number(user.user_login) === 1,
      business: business
        ? {
            name: business.business_name,
            status: Number(business.business_status),
            open: business.business_open,
            close: business.business_close,
            discount: num(business.business_discount),
          }
        : null,
      // A rider signing in here sees the same standing customers gave them in
      // the app. Resolved through the phone join in util/riderLink.js, because
      // the panel account and the delivery-app partner are separate records.
      // Null for vendors, and null for a rider who has never been rated.
      rating: req.panel.portal === "rider" ? await riderRatingFor(user) : null,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal profile ~ err:", err);
    res.status(500).json({ message: "Failed to load profile" });
  }
};

// GET /admin/portal/orders/:id — one order, scoped.
/**
 * What the delivery side is doing with this order, for the vendor's screen.
 *
 * A vendor marking food ready wants one question answered: is a rider coming?
 * Without this the panel can only show the order's own status, which says
 * nothing about whether dispatch found anybody — the exact blind spot that let
 * an order sit with no rider and nobody noticing.
 *
 * Degrades in two steps, because both the delivery tables and the dispatch
 * columns may be absent: no table at all returns null, and a table without the
 * dispatch columns still reports the rider and the job state.
 */
async function deliverySummary(orderId) {
  try {
    const { dispatchReady } = require("../../util/dispatch/columns");
    const hasDispatch = await dispatchReady();

    const extra = hasDispatch
      ? ", `dispatch_state`, `dispatch_at`, `search_radius_km`, `offer_round`, `dispatch_note`"
      : "";

    const [job] = await sequelize.query(
      `SELECT \`do_id\`, \`status\`, \`dp_id\`, \`offered_at\`, \`accepted_at\`,
              \`picked_up_at\`, \`delivered_at\`, \`payment_type\`,
              \`cash_to_collect\`, \`cash_collected\`${extra}
         FROM \`store_delivery_orders\`
        WHERE \`source_order_id\` = :orderId
        ORDER BY \`do_id\` DESC LIMIT 1`,
      { replacements: { orderId }, type: QueryTypes.SELECT }
    );
    if (job == null) return null;

    // The rider's name and number, so the vendor can call the person coming to
    // their door. Nothing else off that record belongs on this screen —
    // except their standing, which is why the rating comes along: a vendor
    // handing food to a stranger benefits from knowing they are well rated,
    // and it is the one number a customer would also see.
    let rider = null;
    if (job.dp_id != null) {
      const [row] = await sequelize.query(
        "SELECT `user_id` AS `dp_id`, `user_name` AS `dp_name`, `user_phone` AS `dp_phone`, `dp_rating` " +
            "FROM `store_users` WHERE `user_id` = :dpId AND `user_role` = 3",
        { replacements: { dpId: job.dp_id }, type: QueryTypes.SELECT }
      );
      if (row) {
        // 0 means unrated, which must not render as a zero-star rider.
        const avg = Number(row.dp_rating) || 0;
        const summary = await summaryForPartner(job.dp_id);
        rider = {
          dp_id: row.dp_id,
          dp_name: row.dp_name,
          dp_phone: row.dp_phone,
          rating: summary ? summary.average : avg,
          rating_count: summary ? summary.count : null,
        };
      }
    }

    return {
      do_id: job.do_id,
      status: job.status,
      rider,
      offered_at: job.offered_at,
      accepted_at: job.accepted_at,
      picked_up_at: job.picked_up_at,
      delivered_at: job.delivered_at,
      payment_type: job.payment_type,
      cash_to_collect: num(job.cash_to_collect),
      cash_collected: Boolean(job.cash_collected),
      dispatch: hasDispatch
        ? {
            state: job.dispatch_state,
            at: job.dispatch_at,
            radius_km: num(job.search_radius_km),
            round: num(job.offer_round),
            note: job.dispatch_note,
          }
        : null,
    };
  } catch (err) {
    // A vendor must still be able to read their order if delivery is unwired.
    console.log("MFB ~ portal ~ deliverySummary ~", err.message);
    return null;
  }
}

exports.orderDetail = async (req, res) => {
  try {
    const order = await StoreOrders.findOne({
      where: { order_id: req.params.id, ...scopeWhere(req.panel) },
      raw: true,
    });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    const [decorated] = await decorate([order]);
    const items = await StoreOrderDetails.findAll({
      where: { order_id: order.order_id },
      raw: true,
    });
    const products = items.length
      ? await Product.findAll({
          where: { product_id: items.map((i) => i.product_id) },
          attributes: ["product_id", "product_name"],
          raw: true,
        })
      : [];
    const nameById = Object.fromEntries(products.map((p) => [p.product_id, p.product_name]));

    res.json({
      order: serialize(decorated),
      items: items.map((i) => ({
        order_detail_id: i.order_detail_id,
        product_name: nameById[i.product_id] || `#${i.product_id}`,
        qty: num(i.product_qty),
        mrp: num(i.product_mrp),
        total: num(i.product_total),
      })),
      delivery: await deliverySummary(order.order_id),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ portal order detail ~ err:", err);
    res.status(500).json({ message: "Failed to load order" });
  }
};
