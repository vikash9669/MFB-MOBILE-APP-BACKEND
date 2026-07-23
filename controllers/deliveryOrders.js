const { Op } = require("sequelize");
const {
  DeliveryOrder,
  DeliveryPartner,
} = require("../models");
const {
  num,
  serializeOrder,
  recordWalletTxn,
  logOrderEvent,
} = require("../util/delivery");
const { notifyPartner } = require("../util/deliveryNotify");

// Same simple incentive model the Home summary uses (13 orders → ₹150 bonus).
const BONUS_TARGET = 13;
const BONUS_AMOUNT = 150;

const ACTIVE_STATES = ["accepted", "picked_up"];

// Finds the partner's single in-progress job, if any.
const findActive = (dpId) =>
  DeliveryOrder.findOne({
    where: { dp_id: dpId, status: { [Op.in]: ACTIVE_STATES } },
    order: [["accepted_at", "DESC"]],
  });

// GET /delivery/orders/incoming — the next unassigned job being offered.
// Returns { order: null } when nothing is available so the app can show the
// "looking for orders" state.
exports.getIncoming = async (req, res) => {
  try {
    // Don't offer a new job while one is already in progress.
    const active = await findActive(req.user.dp_id);
    if (active) {
      return res.json({ order: null, reason: "busy" });
    }

    const offer = await DeliveryOrder.findOne({
      where: { status: "offered", dp_id: null },
      order: [["offered_at", "ASC"]],
    });

    res.json({ order: offer ? serializeOrder(offer) : null });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getIncoming ~ err:", err);
    res.status(500).json({ message: "Failed to load incoming order", err });
  }
};

// GET /delivery/orders/active — the job currently assigned + in progress.
exports.getActive = async (req, res) => {
  try {
    const active = await findActive(req.user.dp_id);
    res.json({ order: active ? serializeOrder(active) : null });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getActive ~ err:", err);
    res.status(500).json({ message: "Failed to load active order", err });
  }
};

// GET /delivery/orders/:id — a single order (any state) owned by the partner.
exports.getOne = async (req, res) => {
  try {
    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json({ order: serializeOrder(order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getOne ~ err:", err);
    res.status(500).json({ message: "Failed to load order", err });
  }
};

// POST /delivery/orders/:id/accept — claim an offered job.
exports.accept = async (req, res) => {
  try {
    const dpId = req.user.dp_id;

    const active = await findActive(dpId);
    if (active) {
      return res.status(409).json({ message: "Finish your current order first" });
    }

    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.status !== "offered" || order.dp_id != null) {
      return res.status(409).json({ message: "Order is no longer available" });
    }

    await order.update({ dp_id: dpId, status: "accepted", accepted_at: new Date() });
    await logOrderEvent(order.do_id, dpId, "accepted", "Partner accepted the order");

    await notifyPartner(dpId, {
      category: "orders",
      icon: "receipt_long",
      title: `Order #${order.order_ref} assigned`,
      body: `Pick up from ${order.pickup_name} · ${order.pickup_area || ""}`.trim(),
      data: { type: "order_assigned", do_id: order.do_id },
    });

    res.json({ message: "Order accepted", order: serializeOrder(order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery accept ~ err:", err);
    res.status(500).json({ message: "Failed to accept order", err });
  }
};

// POST /delivery/orders/:id/reject — decline an offered job (records the pass).
exports.reject = async (req, res) => {
  try {
    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    await logOrderEvent(order.do_id, req.user.dp_id, "rejected", "Partner rejected the offer");
    res.json({ message: "Order rejected" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery reject ~ err:", err);
    res.status(500).json({ message: "Failed to reject order", err });
  }
};

// POST /delivery/orders/:id/verify-pickup — confirm pickup with the store OTP.
exports.verifyPickup = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const { otp } = req.body;

    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null || order.dp_id !== dpId) {
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.status !== "accepted") {
      return res.status(409).json({ message: "Order is not ready for pickup" });
    }
    if (String(otp) !== String(order.pickup_otp)) {
      return res.status(401).json({ message: "Incorrect pickup OTP" });
    }

    if (req.body.photo) {
      await order.update({ proof_photo: req.body.photo });
    }
    await order.update({ status: "picked_up", picked_up_at: new Date() });
    await logOrderEvent(order.do_id, dpId, "picked_up", "Order picked up from store");

    await notifyPartner(dpId, {
      category: "orders",
      icon: "two_wheeler",
      title: `Picked up · Order #${order.order_ref}`,
      body: `Deliver to ${order.drop_name} · ${order.drop_area || ""}`.trim(),
      data: { type: "order_picked_up", do_id: order.do_id },
    });

    res.json({ message: "Pickup confirmed", order: serializeOrder(order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery verifyPickup ~ err:", err);
    res.status(500).json({ message: "Failed to confirm pickup", err });
  }
};

// POST /delivery/orders/:id/verify-delivery — confirm delivery with the
// customer OTP. Credits the partner's earnings, tracks COD cash, and bumps
// lifetime delivery stats. Returns the data the "Delivered!" screen shows.
exports.verifyDelivery = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const { otp, cash_collected } = req.body;

    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null || order.dp_id !== dpId) {
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.status !== "picked_up") {
      return res.status(409).json({ message: "Order has not been picked up yet" });
    }
    if (String(otp) !== String(order.drop_otp)) {
      return res.status(401).json({ message: "Incorrect delivery OTP" });
    }

    const now = new Date();
    const collected = order.payment_type === "COD" && cash_collected !== false;

    await order.update({
      status: "delivered",
      delivered_at: now,
      cash_collected: collected,
      proof_photo: req.body.photo || order.proof_photo,
    });
    await logOrderEvent(order.do_id, dpId, "delivered", "Order delivered to customer");

    // Credit the partner's wallet with this job's earnings.
    await recordWalletTxn(dpId, {
      type: "earning",
      direction: "credit",
      amount: num(order.earn_total),
      title: `Order #${order.order_ref} earning`,
      ref_order_id: order.do_id,
      status: "settled",
    });

    const partner = await DeliveryPartner.findByPk(dpId);

    // COD cash the rider now holds and owes the company.
    if (collected && num(order.cash_to_collect) > 0) {
      await partner.increment("dp_cash_in_hand", { by: num(order.cash_to_collect) });
    }
    await partner.increment("dp_total_deliveries", { by: 1 });
    await partner.reload();

    // Earnings alert for this delivery.
    await notifyPartner(dpId, {
      category: "payments",
      icon: "payments",
      title: `Earned ₹${num(order.earn_total)} · Order #${order.order_ref}`,
      body: "Delivery completed. Earnings added to your wallet.",
      data: { type: "order_delivered", do_id: order.do_id },
    });

    // Congratulate when today's deliveries cross the incentive target.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayDone = await DeliveryOrder.count({
      where: { dp_id: dpId, status: "delivered", delivered_at: { [Op.gte]: todayStart } },
    });
    if (todayDone === BONUS_TARGET) {
      await notifyPartner(dpId, {
        category: "bonuses",
        icon: "emoji_events",
        title: `You unlocked the ₹${BONUS_AMOUNT} bonus 🎉`,
        body: `${BONUS_TARGET} orders completed today. Keep it up!`,
        data: { type: "bonus_unlocked" },
      });
    }

    const durationMin =
      order.picked_up_at != null
        ? Math.max(1, Math.round((now - new Date(order.picked_up_at)) / 60000))
        : num(order.eta_min);

    res.json({
      message: "Delivery confirmed",
      order: serializeOrder(order),
      result: {
        order_ref: order.order_ref,
        earned: num(order.earn_total),
        breakdown: {
          base: num(order.earn_base),
          distance: num(order.earn_distance),
          surge: num(order.earn_surge),
          tip: num(order.earn_tip),
        },
        duration_min: durationMin,
        wallet_balance: num(partner.dp_wallet_balance),
      },
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery verifyDelivery ~ err:", err);
    res.status(500).json({ message: "Failed to confirm delivery", err });
  }
};

// GET /delivery/orders/history — the partner's completed jobs, newest first.
exports.getHistory = async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const orders = await DeliveryOrder.findAll({
      where: { dp_id: req.user.dp_id, status: "delivered" },
      order: [["delivered_at", "DESC"]],
      limit,
    });
    res.json({ orders: orders.map(serializeOrder) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getHistory ~ err:", err);
    res.status(500).json({ message: "Failed to load history", err });
  }
};
