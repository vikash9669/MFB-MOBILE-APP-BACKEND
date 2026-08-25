// Orders — the React equivalent of administration/Orders (Index, OrderDetails,
// OrderAddress, OrderUpdate, paymentUpdate, Reports).
const { Op, fn, col, literal } = require("sequelize");
const {
  StoreOrders,
  StoreOrderDetails,
  StoreOrderLogs,
  Product,
  User,
  Business,
  Address,
  Location,
  Area,
  Cashback,
  DeliveryPartner,
} = require("../../models");
const { QueryTypes } = require("sequelize");
const sequelize = require("../../util/database");
const { collectionReady } = require("../../util/collectionColumns");
const { STATUS_LABELS } = require("./dashboard");
const { addressAttributes } = require("../../util/addressColumns");
const { notifyOrderReceived } = require("./notify");
const { RIDER_ROLE, VENDOR_ROLE } = require("../../middlewares/verifyAdmin");
const { assignToPanelRider } = require("../../util/riderAssignment");

const num = (v) => Number(v || 0);
const label = (s) => STATUS_LABELS[Number(s)] || "Unknown";

// Status 3 is "Ready to Ship". administration/Ajax::Status settled the cashback
// ledger at exactly this point, and nothing else in the codebase does it.
const CASHBACK_SETTLE_STATUS = 3;

// Recomputes an order's money from its line items, the way both
// Orders::OrderUpdate and Orders::InvoiceProductAdd did after every change:
// only available lines count, and the vendor's discount percentage is applied
// to the resulting subtotal.
async function recalcOrderTotals(orderId, transaction) {
  const order = await StoreOrders.findByPk(orderId, { transaction });
  if (order == null) return null;

  const [row] = await StoreOrderDetails.findAll({
    attributes: [[fn("COALESCE", fn("SUM", col("product_total")), 0), "subtotal"]],
    where: { order_id: orderId, product_available: 1 },
    raw: true,
    transaction,
  });

  const subtotal = num(row?.subtotal);
  const discount = (subtotal * num(order.vendor_discount)) / 100;
  await order.update(
    { order_discount: discount, order_amount: subtotal - discount },
    { transaction }
  );
  return order;
}

/** Appends to store_orders_log, as every PHP status write did. */
async function logStatus(orderId, userId, status, transaction) {
  await StoreOrderLogs.create(
    { order_id: orderId, user_id: userId, order_status: status },
    { transaction }
  );
}

// Shared with the vendor portal. A vendor marking an order ready is the same
// event as an admin doing it from this screen, so it has to leave the same trail
// and settle the same ledger — see portal.updateStatus.
exports.logStatus = logStatus;
exports.CASHBACK_SETTLE_STATUS = CASHBACK_SETTLE_STATUS;

// Credits every pending cashback row for an order to the customer's balance —
// the transaction Ajax::Status ran when an order reached status 3.
//
// cashback_status 1 means "credited and visible" (store/User.php lists exactly
// those rows); 0 means pending. Two deliberate differences from the PHP:
//
//   * It only touches rows at 0. Ajax::Status re-credited EVERY row for the
//     order, including already-settled referral bonuses, so each trip through
//     status 3 paid them out again. This version is idempotent.
//   * It is a no-op today. The only code that inserts cashback rows is the
//     referral bonus in store/User_Model.php, which writes them at status 1,
//     already credited. The order-time insert in store/Store_Model.php is
//     commented out, so nothing currently creates a pending row. The settlement
//     is here so that re-enabling that insert works; it does not, on its own,
//     start paying cashback again.
async function settleCashback(orderId, transaction) {
  const pending = await Cashback.findAll({
    where: { order_id: orderId, cashback_status: 0 },
    transaction,
  });
  if (pending.length === 0) return 0;

  for (const row of pending) {
    const user = await User.findByPk(row.user_id, { transaction });
    if (user == null) continue;
    await user.update(
      { user_cashback: num(user.user_cashback) + num(row.cashback_earned) },
      { transaction }
    );
    await row.update(
      { cashback_status: 1, cashback_time: new Date() },
      { transaction }
    );
  }
  return pending.length;
}

exports.settleCashback = settleCashback;

// Builds the WHERE clause shared by the list and the CSV export.
const buildWhere = (q) => {
  const where = {};
  if (q.status !== undefined && q.status !== "") {
    where.order_status = Number(q.status);
  }
  if (q.payment_type) {
    where.order_payment_type = q.payment_type;
  }
  if (q.vendor_id) {
    where.vendor_id = Number(q.vendor_id);
  }
  if (q.customer_id) {
    where.customer_id = Number(q.customer_id);
  }
  if (q.rider_id) {
    where.rider_id = Number(q.rider_id);
  }
  if (q.from || q.to) {
    where.order_received_time = {};
    if (q.from) where.order_received_time[Op.gte] = new Date(`${q.from}T00:00:00`);
    if (q.to) where.order_received_time[Op.lte] = new Date(`${q.to}T23:59:59`);
  }
  if (q.search) {
    const s = String(q.search).trim();
    if (/^\d+$/.test(s)) {
      where.order_id = Number(s);
    }
  }
  return where;
};

// Decorates a set of order rows with customer / vendor / rider names in bulk.
const withPeople = async (rows) => {
  const ids = [
    ...new Set(rows.flatMap((o) => [o.customer_id, o.vendor_id, o.rider_id]).filter(Boolean)),
  ];
  if (ids.length === 0) return rows.map((o) => ({ ...o }));
  const [people, businesses] = await Promise.all([
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
  ]);
  const byId = Object.fromEntries(people.map((p) => [p.user_id, p]));
  const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));
  return rows.map((o) => ({
    ...o,
    customer_name: byId[o.customer_id]?.user_name || null,
    customer_phone: byId[o.customer_id]?.user_phone || null,
    vendor_name: bizById[o.vendor_id] || byId[o.vendor_id]?.user_name || null,
    rider_name: byId[o.rider_id]?.user_name || null,
  }));
};

const serialize = (o) => ({
  order_id: o.order_id,
  customer_id: o.customer_id,
  customer_name: o.customer_name,
  customer_phone: o.customer_phone,
  vendor_id: o.vendor_id,
  vendor_name: o.vendor_name,
  rider_id: o.rider_id,
  rider_name: o.rider_name,
  address_id: o.address_id,
  amount: num(o.order_amount),
  discount: num(o.order_discount),
  delivery_charges: num(o.delivery_charges),
  amount_paid: num(o.order_amount_paid),
  payable: num(o.order_amount) + num(o.delivery_charges) - num(o.order_discount),
  payment_type: o.order_payment_type,
  payment_status: Number(o.order_payment_status),
  payment_received: Number(o.order_payment_received),
  transaction_id: o.order_transaction_id,
  status: Number(o.order_status),
  status_label: label(o.order_status),
  placed_at: o.order_received_time,
  delivered_at: o.order_delivered_time,
});

// GET /admin/orders?page=&limit=&status=&from=&to=&search=
exports.list = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const where = buildWhere(req.query);

    const { count, rows } = await StoreOrders.findAndCountAll({
      where,
      order: [["order_id", "DESC"]],
      limit,
      offset: (page - 1) * limit,
      raw: true,
    });

    const decorated = await withPeople(rows);
    res.json({
      orders: decorated.map(serialize),
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit),
      status_labels: STATUS_LABELS,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin orders list ~ err:", err);
    res.status(500).json({ message: "Failed to load orders" });
  }
};

// GET /admin/orders/:id — order + line items + delivery address.
exports.detail = async (req, res) => {
  try {
    const order = await StoreOrders.findByPk(req.params.id, { raw: true });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    const [decorated] = await withPeople([order]);

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

    // Attributes are named because the map columns are added by a migration
    // that may not have run — see util/addressColumns.js.
    const address = order.address_id
      ? await Address.findByPk(order.address_id, {
          attributes: await addressAttributes(),
          raw: true,
        })
      : null;
    const city = address?.delivery_city ? await Location.findByPk(address.delivery_city, { raw: true }) : null;

    // The audit trail Orders::OrderUpdate wrote but no PHP screen ever showed.
    const logs = await StoreOrderLogs.findAll({
      where: { order_id: order.order_id },
      order: [["log_id", "ASC"]],
      raw: true,
    });
    const actorIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))];
    const actors = actorIds.length
      ? await User.findAll({
          where: { user_id: actorIds },
          attributes: ["user_id", "user_name"],
          raw: true,
        })
      : [];
    const actorById = Object.fromEntries(actors.map((a) => [a.user_id, a.user_name]));

    // Was this paid up front, or handed over as cash, or taken online at the
    // door? After a doorstep collection the order reads exactly like a prepaid
    // one — payment_type PG, status 1 — and staff chasing a cash shortfall
    // need to be able to tell the two apart.
    let paymentCollection = null;
    try {
      if (await collectionReady()) {
        const [row] = await sequelize.query(
          `SELECT \`amount\`, \`status\`, \`collected_by_dp_id\`, \`updatedAt\`
             FROM \`store_payment_intents\`
            WHERE \`order_id\` = :id AND \`purpose\` = 'cod_collection'
            ORDER BY \`pi_id\` DESC LIMIT 1`,
          { replacements: { id: order.order_id }, type: QueryTypes.SELECT }
        );
        if (row) {
          paymentCollection = {
            at_doorstep: true,
            state: row.status,
            amount: Number(row.amount),
            rider_id: row.collected_by_dp_id,
            at: row.updatedAt,
          };
        }
      }
    } catch (err) {
      console.log("MFB ~ admin order detail ~ collection lookup ~", err.message);
    }

    res.json({
      order: serialize(decorated),
      payment_collection: paymentCollection,
      items: items.map((i) => ({
        order_detail_id: i.order_detail_id,
        product_id: i.product_id,
        product_name: nameById[i.product_id] || `#${i.product_id}`,
        qty: num(i.product_qty),
        mrp: num(i.product_mrp),
        price: num(i.product_price),
        discount: num(i.product_discount),
        total: num(i.product_total),
        available: Number(i.product_available),
      })),
      address: address
        ? {
            delivery_id: address.delivery_id,
            address: address.delivery_address,
            landmark: address.delivery_landmark,
            phone: address.delivery_phone,
            pin: address.delivery_pin,
            city: city?.location_name || null,
            city_id: address.delivery_city ?? null,
            state_id: address.delivery_state ?? null,
            // Null on any address saved before the map picker, and on any the
            // customer typed by hand. The panel renders a map only when both
            // are present.
            lat: address.delivery_lat != null ? Number(address.delivery_lat) : null,
            lng: address.delivery_lng != null ? Number(address.delivery_lng) : null,
            house: address.delivery_house ?? null,
            label: address.delivery_label ?? null,
            formatted: address.delivery_formatted ?? null,
          }
        : null,
      timeline: logs.map((l) => ({
        log_id: l.log_id,
        status: Number(l.order_status),
        label: label(l.order_status),
        by: actorById[l.user_id] || `#${l.user_id}`,
        at: l.createdAt ?? l.updatedAt ?? null,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin order detail ~ err:", err);
    res.status(500).json({ message: "Failed to load order" });
  }
};

// PUT /admin/orders/:id/status  { status, rider_id }  — Orders::OrderUpdate.
//
// Both fields are optional and either may appear alone. The PHP treated an
// assignment as a status change too: giving a still-unprocessed order (status 0)
// a rider bumped it to 2 and emailed the rider and the vendor. That behaviour is
// preserved, along with the store_orders_log row and the cashback settlement
// Ajax::Status performed on the way into status 3.
exports.updateStatus = async (req, res) => {
  const hasStatus = req.body.status !== undefined && req.body.status !== null;
  const hasRider = req.body.rider_id !== undefined;

  if (!hasStatus && !hasRider) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  let status = hasStatus ? Number(req.body.status) : null;
  if (hasStatus && (!Number.isInteger(status) || status < 0 || status >= STATUS_LABELS.length)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  // rider_id: null clears the assignment, a number sets it.
  let riderId;
  if (hasRider) {
    riderId = req.body.rider_id === null || req.body.rider_id === "" ? null : Number(req.body.rider_id);
    if (riderId !== null && !Number.isInteger(riderId)) {
      return res.status(400).json({ message: "Invalid rider" });
    }
    if (riderId !== null) {
      const rider = await User.findByPk(riderId, { raw: true });
      if (rider == null || Number(rider.user_role) !== RIDER_ROLE) {
        return res.status(400).json({ message: "That user is not a rider" });
      }
    }
  }

  const transaction = await sequelize.transaction();
  try {
    const order = await StoreOrders.findByPk(req.params.id, { transaction });
    if (order == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    // Assigning a rider to an order nobody has picked up yet moves it forward,
    // exactly as `$status = ($status == 0 ? 2 : $status)` did.
    if (hasRider && riderId !== null) {
      const current = status === null ? Number(order.order_status) : status;
      status = current === 0 ? 2 : current;
    }

    const patch = { order_updated_by: req.panel.user_id };
    if (hasRider) patch.rider_id = riderId;
    if (status !== null) {
      patch.order_status = status;
      // Status 5 is Delivered — stamp the delivery time like the PHP panel did.
      if (status === 5 && order.order_delivered_time == null) {
        patch.order_delivered_time = new Date();
      }
    }
    await order.update(patch, { transaction });

    let cashbackSettled = 0;
    if (status !== null) {
      await logStatus(order.order_id, req.panel.user_id, status, transaction);
      if (status === CASHBACK_SETTLE_STATUS) {
        cashbackSettled = await settleCashback(order.order_id, transaction);
      }
    }

    await transaction.commit();

    // Mail after the commit — a bounced email must not undo the assignment.
    let notified = null;
    if (hasRider && riderId !== null && status === 2) {
      notified = await notifyOrderReceived(order.order_id).catch((err) => {
        console.log("MFB-error-logs ~ notify on assign ~ err:", err.message);
        return null;
      });
    }

    // Reach the rider's app, not just their inbox.
    //
    // store_orders.rider_id is the panel's half of the assignment and predates
    // the delivery app entirely. On its own it changes nothing the rider can
    // see: their app reads store_delivery_orders keyed by dp_id, so an order
    // "assigned" here stayed invisible to them. Bridged after the commit and
    // best-effort, on the same principle as the mail above — the assignment
    // itself is already durable, and a push must not be able to undo it.
    let dispatched = null;
    if (hasRider && riderId !== null) {
      dispatched = await assignToPanelRider(order.order_id, riderId, {
        previousRiderId: order.rider_id,
      });
    }

    res.json({
      message: "Order updated",
      status: status === null ? Number(order.order_status) : status,
      status_label: label(status === null ? order.order_status : status),
      rider_id: hasRider ? riderId : order.rider_id,
      cashback_settled: cashbackSettled,
      notified,
      dispatched,
    });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin order status ~ err:", err);
    res.status(500).json({ message: "Failed to update order" });
  }
};

// PUT /admin/orders/:id/items/:detailId  { qty, available } — the qty branch of
// Orders::OrderUpdate. Setting qty to 0 marks the line unavailable, which is how
// the PHP panel recorded "the vendor is out of this"; the order total is
// recomputed from the remaining available lines either way.
exports.updateItem = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const item = await StoreOrderDetails.findOne({
      where: { order_detail_id: req.params.detailId, order_id: req.params.id },
      transaction,
    });
    if (item == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Line item not found" });
    }

    const patch = {};
    if (req.body.qty !== undefined) {
      const qty = Number(req.body.qty);
      if (!Number.isInteger(qty) || qty < 0) {
        await transaction.rollback();
        return res.status(400).json({ message: "Quantity must be zero or more" });
      }
      patch.product_qty = qty;
      patch.product_total = qty * num(item.product_mrp);
      patch.product_available = qty === 0 ? 0 : 1;
    }
    if (req.body.available !== undefined) {
      patch.product_available = Number(req.body.available) ? 1 : 0;
    }
    if (Object.keys(patch).length === 0) {
      await transaction.rollback();
      return res.status(400).json({ message: "Nothing to update" });
    }

    await item.update(patch, { transaction });
    const order = await recalcOrderTotals(req.params.id, transaction);
    await transaction.commit();

    res.json({
      message: "Item updated",
      amount: num(order?.order_amount),
      discount: num(order?.order_discount),
    });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin order item ~ err:", err);
    res.status(500).json({ message: "Failed to update item" });
  }
};

// POST /admin/orders/:id/items  { product_id, qty } — Orders::InvoiceProductAdd.
//
// The PHP added a product to a placed order, bumping the quantity when the line
// already existed. It is restricted here to products belonging to the order's
// own vendor: the PHP's own search query joined on the vendor's business, so
// adding another restaurant's dish was never intended.
exports.addItem = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const order = await StoreOrders.findByPk(req.params.id, { transaction });
    if (order == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    const productId = Number(req.body.product_id);
    const qty = Math.max(1, Number(req.body.qty) || 1);
    const product = await Product.findByPk(productId, { transaction });
    if (product == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Product not found" });
    }
    if (order.vendor_id && Number(product.product_user_id) !== Number(order.vendor_id)) {
      await transaction.rollback();
      return res.status(400).json({ message: "That product belongs to a different vendor" });
    }

    const mrp = num(product.product_mrp);
    const existing = await StoreOrderDetails.findOne({
      where: { order_id: order.order_id, product_id: productId },
      transaction,
    });

    if (existing) {
      const newQty = num(existing.product_qty) + qty;
      await existing.update(
        { product_qty: newQty, product_total: newQty * mrp, product_available: 1 },
        { transaction }
      );
    } else {
      await StoreOrderDetails.create(
        {
          order_id: order.order_id,
          product_id: productId,
          product_qty: qty,
          product_mrp: mrp,
          product_price: num(product.product_price) || mrp,
          product_discount: 0,
          product_available: 1,
          product_total: qty * mrp,
        },
        { transaction }
      );
    }

    const updated = await recalcOrderTotals(order.order_id, transaction);
    await transaction.commit();

    res.status(201).json({
      message: "Item added",
      amount: num(updated?.order_amount),
      discount: num(updated?.order_discount),
    });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin add order item ~ err:", err);
    res.status(500).json({ message: "Failed to add item" });
  }
};

// DELETE /admin/orders/:id/items/:detailId
//
// The PHP had no delete — it set qty to 0 and left the row as a record of what
// the customer originally asked for. That is the better default, so this is kept
// for genuine mistakes (a line added to the wrong order) and nothing else.
exports.removeItem = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const removed = await StoreOrderDetails.destroy({
      where: { order_detail_id: req.params.detailId, order_id: req.params.id },
      transaction,
    });
    if (removed === 0) {
      await transaction.rollback();
      return res.status(404).json({ message: "Line item not found" });
    }
    const order = await recalcOrderTotals(req.params.id, transaction);
    await transaction.commit();
    res.json({
      message: "Item removed",
      amount: num(order?.order_amount),
      discount: num(order?.order_discount),
    });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin remove order item ~ err:", err);
    res.status(500).json({ message: "Failed to remove item" });
  }
};

// GET /admin/orders/:id/catalogue?search= — the product picker behind
// InvoiceProductAdd, scoped to the order's vendor.
exports.orderCatalogue = async (req, res) => {
  try {
    const order = await StoreOrders.findByPk(req.params.id, { raw: true });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    const where = { product_user_id: order.vendor_id };
    if (req.query.search) {
      where.product_name = { [Op.like]: `%${String(req.query.search).trim()}%` };
    }
    const rows = await Product.findAll({
      where,
      attributes: ["product_id", "product_name", "product_mrp", "product_image"],
      order: [["product_name", "ASC"]],
      limit: 40,
      raw: true,
    });
    res.json({
      products: rows.map((p) => ({
        product_id: p.product_id,
        name: p.product_name,
        mrp: num(p.product_mrp),
        image: p.product_image || null,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin order catalogue ~ err:", err);
    res.status(500).json({ message: "Failed to search products" });
  }
};

// PUT /admin/orders/:id/address — administration/Orders::OrderAddress.
//
// Editing the address can change what delivery costs, so the PHP re-read the
// vendor's store_users_area row for the new city and re-applied the charge. It
// only ever raised the charge (its `if` was one-sided); this also clears it when
// the order now qualifies for free delivery, which is what the rule means.
exports.updateAddress = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const order = await StoreOrders.findByPk(req.params.id, { transaction });
    if (order == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    if (!order.address_id) {
      await transaction.rollback();
      return res.status(400).json({ message: "This order has no delivery address" });
    }
    const address = await Address.findByPk(order.address_id, {
      attributes: await addressAttributes(),
      transaction,
    });
    if (address == null) {
      await transaction.rollback();
      return res.status(404).json({ message: "Delivery address not found" });
    }

    const patch = {};
    if (req.body.address !== undefined) patch.delivery_address = String(req.body.address);
    if (req.body.landmark !== undefined) patch.delivery_landmark = String(req.body.landmark);
    if (req.body.phone !== undefined) patch.delivery_phone = String(req.body.phone);
    if (req.body.pin !== undefined) patch.delivery_pin = String(req.body.pin);
    if (req.body.city_id !== undefined) patch.delivery_city = Number(req.body.city_id);
    if (req.body.state_id !== undefined) patch.delivery_state = Number(req.body.state_id);
    if (Object.keys(patch).length === 0) {
      await transaction.rollback();
      return res.status(400).json({ message: "Nothing to update" });
    }
    await address.update(patch, { transaction });

    // Re-price delivery against the vendor's rules for the (possibly new) city.
    const cityId = patch.delivery_city ?? address.delivery_city;
    let charges = null;
    if (order.vendor_id && cityId) {
      const area = await Area.findOne({
        where: { area_user_id: order.vendor_id, area_id: cityId },
        raw: true,
        transaction,
      });
      if (area) {
        const freeAbove = num(area.area_charge_free);
        const charge = num(order.order_amount) < freeAbove ? num(area.area_charge) : 0;
        await order.update({ delivery_charges: charge }, { transaction });
        charges = charge;
      }
    }

    await transaction.commit();
    res.json({ message: "Address updated", delivery_charges: charges });
  } catch (err) {
    await transaction.rollback();
    console.log("MFB-error-logs ~ admin order address ~ err:", err);
    res.status(500).json({ message: "Failed to update address" });
  }
};

// PUT /admin/orders/:id/payment — administration/Orders::paymentUpdate
exports.updatePayment = async (req, res) => {
  try {
    const order = await StoreOrders.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    const patch = {};
    if (req.body.payment_status !== undefined) {
      patch.order_payment_status = Number(req.body.payment_status) ? 1 : 0;
    }
    if (req.body.payment_received !== undefined) {
      patch.order_payment_received = Number(req.body.payment_received) ? 1 : 0;
    }
    if (req.body.amount_paid !== undefined) {
      patch.order_amount_paid = num(req.body.amount_paid);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }
    patch.order_updated_by = req.admin.user_id;
    await order.update(patch);
    res.json({ message: "Payment updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin order payment ~ err:", err);
    res.status(500).json({ message: "Failed to update payment" });
  }
};

// GET /admin/orders/reports?from=&to=  — administration/Orders::Reports
exports.reports = async (req, res) => {
  try {
    const where = buildWhere(req.query);
    const [totals] = await StoreOrders.findAll({
      attributes: [
        [fn("COUNT", col("order_id")), "orders"],
        [fn("COALESCE", fn("SUM", col("order_amount")), 0), "amount"],
        [fn("COALESCE", fn("SUM", col("delivery_charges")), 0), "delivery"],
        [fn("COALESCE", fn("SUM", col("order_discount")), 0), "discount"],
        [fn("COALESCE", fn("SUM", col("order_profit")), 0), "profit"],
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

    const byStatus = await StoreOrders.findAll({
      attributes: ["order_status", [fn("COUNT", col("order_id")), "count"]],
      where,
      group: ["order_status"],
      raw: true,
    });

    // Payment breakup — Orders::Reports built this from order_payment_status
    // (1=PG, 2=Wallet, 3=Cash, 4=Unpaid) split by order_payment_received.
    // The column is aliased rather than selected by name so the model's BOOLEAN
    // type does not collapse 2/3/4 into `true` on the way out.
    const byPayment = await StoreOrders.findAll({
      attributes: [
        [literal("`order_payment_status`"), "method"],
        [literal("`order_payment_received`"), "received"],
        [fn("COUNT", col("order_id")), "count"],
        [fn("COALESCE", fn("SUM", col("order_amount")), 0), "amount"],
      ],
      where,
      group: [literal("`order_payment_status`"), literal("`order_payment_received`")],
      raw: true,
    });

    const METHODS = { 1: "PG", 2: "Wallet", 3: "Cash", 4: "Unpaid" };
    const breakup = {};
    for (const row of byPayment) {
      const name = METHODS[Number(row.method)] || "Unpaid";
      breakup[name] ??= { paid: 0, pending: 0, orders: 0 };
      breakup[name][Number(row.received) ? "paid" : "pending"] += num(row.amount);
      breakup[name].orders += num(row.count);
    }

    // Vendor payable — PHP applied one business_commision to the whole total,
    // which only held when the report was filtered to a single vendor. Summing
    // per vendor gives the same answer there and a correct one otherwise.
    const byVendor = await StoreOrders.findAll({
      attributes: [
        "vendor_id",
        [fn("COUNT", col("order_id")), "orders"],
        [fn("COALESCE", fn("SUM", col("order_amount")), 0), "amount"],
      ],
      where,
      group: ["vendor_id"],
      raw: true,
    });
    const vendorIds = byVendor.map((v) => v.vendor_id).filter(Boolean);
    const businesses = vendorIds.length
      ? await Business.findAll({
          where: { user_id: vendorIds },
          attributes: ["user_id", "business_name", "business_commision"],
          raw: true,
        })
      : [];
    const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b]));

    const vendors = byVendor.map((v) => {
      const biz = bizById[v.vendor_id];
      const commission = num(biz?.business_commision);
      const amount = num(v.amount);
      return {
        vendor_id: v.vendor_id,
        vendor_name: biz?.business_name || `#${v.vendor_id}`,
        orders: num(v.orders),
        amount,
        commission,
        payable: amount - (amount * commission) / 100,
      };
    });
    vendors.sort((a, b) => b.amount - a.amount);

    // The PHP report printed the matching orders under the summary, so the
    // numbers could be checked against the rows that produced them. Capped
    // because a wide date range can match six figures of orders.
    const ROWS_LIMIT = 200;
    const rows = await StoreOrders.findAll({
      where,
      order: [["order_id", "DESC"]],
      limit: ROWS_LIMIT,
      raw: true,
    });
    const decorated = await withPeople(rows);

    res.json({
      totals: {
        orders: num(totals?.orders),
        amount: num(totals?.amount),
        delivery: num(totals?.delivery),
        discount: num(totals?.discount),
        profit: num(totals?.profit),
        payable: vendors.reduce((sum, v) => sum + v.payable, 0),
        commission: vendors.reduce((sum, v) => sum + (v.amount - v.payable), 0),
      },
      orders: decorated.map(serialize),
      orders_truncated: num(totals?.orders) > ROWS_LIMIT,
      orders_limit: ROWS_LIMIT,
      daily: daily.map((d) => ({ day: d.day, orders: num(d.orders), amount: num(d.amount) })),
      by_status: byStatus.map((s) => ({
        status: Number(s.order_status),
        label: label(s.order_status),
        count: num(s.count),
      })),
      by_payment: Object.entries(breakup).map(([method, v]) => ({ method, ...v })),
      by_vendor: vendors,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin order reports ~ err:", err);
    res.status(500).json({ message: "Failed to build report" });
  }
};

// GET /admin/lookups — the dropdowns every PHP screen filled with
// USER->_GetUsersList(3) and _GetUsersList(4): riders and vendors, name + id.
exports.lookups = async (req, res) => {
  try {
    const [riders, vendorUsers, businesses, partners] = await Promise.all([
      User.findAll({
        where: { user_role: RIDER_ROLE },
        attributes: ["user_id", "user_name", "user_phone", "user_status"],
        order: [["user_name", "ASC"]],
        raw: true,
      }),
      User.findAll({
        where: { user_role: VENDOR_ROLE },
        attributes: ["user_id", "user_name"],
        order: [["user_name", "ASC"]],
        raw: true,
      }),
      Business.findAll({ attributes: ["user_id", "business_name"], raw: true }),
      // The delivery-app side of the same rows: whether the rider is signed in
      // and accepting work right now. Same store_users table, dp_* columns.
      DeliveryPartner.findAll({
        attributes: ["dp_id", "dp_online", "dp_verification_status"],
        raw: true,
      }),
    ]);
    const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));
    const partnerById = Object.fromEntries(partners.map((p) => [p.dp_id, p]));

    res.json({
      riders: riders.map((r) => {
        const dp = partnerById[r.user_id];
        return {
          user_id: r.user_id,
          name: r.user_name,
          phone: r.user_phone,
          active: Number(r.user_status) === 1,
          // For the manual-assign dropdown, which shows only online riders. A
          // rider with no app account (dp row) is treated as offline.
          online: dp != null && Number(dp.dp_online) === 1 && dp.dp_verification_status === "approved",
        };
      }),
      vendors: vendorUsers.map((v) => ({
        user_id: v.user_id,
        name: bizById[v.user_id] || v.user_name,
      })),
      status_labels: STATUS_LABELS,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin lookups ~ err:", err);
    res.status(500).json({ message: "Failed to load lookups" });
  }
};
