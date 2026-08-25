const { Op } = require("sequelize");
const axios = require("axios");
const {
  StoreOrders,
  StoreOrderDetails,
  Product,
  Business,
  Address,
  Area,
  User,
} = require("../models");
const { getCouponCodeDetails } = require("./coupon");
const { notifyUser } = require("./customerNotify");
const { queueDeliveryJob } = require("./deliveryDispatch");

// Shared order pipeline for both the COD path (controllers/order.js) and the
// PhonePe path (controllers/payment.js). Pricing is computed here, server-side,
// from product ids only — the client never sends prices.

// Prices a cart. Returns every figure store_orders needs, so the caller only
// decides the payment columns.
const priceCart = async ({
  address_id,
  product_ids_with_quantity,
  business_user_id,
  coupon_code,
  platform,
}) => {
  const product_ids = Object.keys(product_ids_with_quantity);

  const productDetails = await Product.findAll({
    where: { product_id: product_ids },
  });
  const address = await Address.findByPk(address_id);
  const business = await Business.findOne({
    where: { user_id: business_user_id },
  });

  if (address == null) throw new Error("Address not found");
  if (business == null) throw new Error("Restaurant not found");

  const areaDetails = await Area.findOne({
    where: {
      [Op.and]: [
        { area_id: address.delivery_city },
        { area_user_id: business_user_id },
      ],
    },
  });

  if (areaDetails == null) {
    throw new Error("This restaurant does not deliver to the selected address");
  }

  const orderAmount = productDetails.reduce(
    (prev, curr) =>
      prev + curr.product_mrp * product_ids_with_quantity[curr.product_id],
    0
  );

  let businessDiscount = 0;
  if (business.business_discount != null && business.business_discount > 0) {
    businessDiscount = Math.floor(
      orderAmount - orderAmount * ((100 - business.business_discount) / 100)
    );
  }

  const rainCharges =
    business.business_rain_charges > 0 ? business.business_rain_charges : 0;

  const couponCodeDetails = getCouponCodeDetails({
    code: coupon_code,
    orderAmount,
    platform,
  });

  const delivery_charges =
    couponCodeDetails.freeDelivery === true ||
    orderAmount >= areaDetails.area_charge_free
      ? 0
      : areaDetails.area_charge;

  const order_discount =
    couponCodeDetails.discount > 0 ? couponCodeDetails.discount : businessDiscount;

  // What store_orders.order_amount holds: goods after the vendor discount,
  // plus rain surcharge, before delivery.
  const order_amount = orderAmount - businessDiscount + rainCharges;

  // What the customer actually pays, and so what we charge via PhonePe. This
  // matches the total the cart screen renders.
  const payable = order_amount + delivery_charges - order_discount;

  return {
    productDetails,
    order_amount,
    order_discount,
    delivery_charges,
    payable,
  };
};

// The attribute list every order response uses. Kept in one place because it
// was previously repeated verbatim in three queries.
const ORDER_ATTRIBUTES = [
  "order_id",
  "customer_id",
  "vendor_id",
  "address_id",
  "rider_id",
  "vendor_discount",
  "order_amount",
  "order_discount",
  "delivery_charges",
  "order_amount_paid",
  "order_profit",
  "order_payment_type",
  "order_transaction_id",
  "order_payment_status",
  "order_payment_received",
  "order_received_time",
  "order_delivered_time",
  "order_status",
  "order_updated_by",
];

const ORDER_INCLUDES = [
  {
    model: StoreOrderDetails,
    attributes: [
      "order_detail_id",
      "product_id",
      "product_qty",
      "product_mrp",
      "product_price",
      "product_discount",
      "product_total",
      "product_available",
    ],
    include: { model: Product, attributes: ["product_name"] },
  },
  { model: Business, attributes: ["business_name", "user_id"] },
];

// Writes store_orders + store_orders_details.
//
// `payment` carries the four columns the admin panel and rider app read. The
// contract is taken from the legacy PHP (admin/store/models/Store_Model.php):
//   COD → type COD, txn 'COD', paid 0, status 0, received 0
//   PG  → type PG,  txn <gateway id>, paid <amount>, status 1, received 1
//
// NOTE ON order_amount_paid: the column is SMALLINT (max 32767) and the legacy
// Razorpay code wrote *paise* into it, so every order over ₹327.67 was stored
// clamped/corrupt. We write rupees, matching order_amount's units, which keeps
// real order values well inside the column.
const createOrder = async ({
  user_id,
  business_user_id,
  address_id,
  product_ids_with_quantity,
  pricing,
  payment,
}) => {
  const newOrder = await StoreOrders.create({
    customer_id: user_id,
    vendor_id: business_user_id,
    address_id,
    rider_id: 1,
    vendor_discount: 0,
    order_amount: pricing.order_amount,
    order_discount: pricing.order_discount,
    delivery_charges: pricing.delivery_charges,
    order_status: 0,
    order_updated_by: user_id,
    // Plain server time. The IST conversion now happens in the driver — see the
    // timezone note in util/database.js. The manual `+ 5.5h` that used to be
    // here made the stored value agree with the legacy rows but disagree with
    // the clock, so every countdown and "since" query inherited the error.
    order_received_time: new Date(),
    ...payment,
  });

  for (const product of pricing.productDetails) {
    const product_qty = product_ids_with_quantity[product.product_id];
    await StoreOrderDetails.create({
      order_id: newOrder.order_id,
      product_id: product.product_id,
      product_qty,
      product_mrp: product.product_mrp,
      product_price: 0,
      product_discount: 0,
      product_total: product.product_mrp * product_qty,
      product_available: 1,
    });
  }

  return newOrder;
};

const findOrderById = (order_id) =>
  StoreOrders.findOne({
    attributes: ORDER_ATTRIBUTES,
    where: { order_id },
    include: ORDER_INCLUDES,
  });

// Best-effort post-order side effects. Never allowed to fail an order that is
// already committed (and, for PG, already paid for).
const runPostOrderSideEffects = async ({ user_id, order_id, total_amount }) => {
  try {
    const userDetails = await User.findByPk(user_id, {
      attributes: ["user_name", "user_phone"],
    });
    await axios.post(
      "https://myfirstbite.in/Api/sendmailapi",
      {
        user_name: userDetails?.user_name || "Unknown User",
        user_phone: userDetails?.user_phone || "0000000000",
        total_amount,
        order_id: String(order_id),
      },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
  } catch (emailError) {
    console.error("Failed to send email notification:", emailError.message);
  }

  try {
    await notifyUser(user_id, {
      category: "orders",
      icon: "receipt_long",
      title: "Order placed 🎉",
      body: `We've received order #${order_id}. We'll keep you updated here.`,
      refOrderId: order_id,
    });
  } catch (notifyError) {
    console.error("Failed to raise order notification:", notifyError.message);
  }

  // Make sure the delivery address has coordinates, so the tracking map has a
  // destination to draw. Addresses created through the app already carry a pin
  // from the map picker; the ones inherited from the PHP panel do not, and this
  // fills them in once, the first time somebody orders to them.
  //
  // Deliberately NOT awaited. It costs a Google lookup and the customer is
  // waiting on this response; the tracking screen polls, so a pin that lands a
  // second later is indistinguishable from one that was already there.
  //
  // `address` was never in scope here — this function is called with
  // { user_id, order_id, total_amount } and nothing else — so every order threw
  // ReferenceError: address is not defined, the catch swallowed it, and the
  // geocode never ran once. That is why delivery addresses had no coordinates
  // and the tracking map had no destination to draw.
  //
  // Loaded from the order instead, so no caller has to change. Fire-and-forget
  // for the reason above: the customer is waiting on this response.
  void (async () => {
    const { ensureAddressPin } = require("./addressGeo");
    const placed = await StoreOrders.findByPk(order_id, { attributes: ["address_id"] });
    if (placed?.address_id == null) return;
    const address = await Address.findByPk(placed.address_id);
    if (address != null) await ensureAddressPin(address);
  })().catch((geoError) =>
    console.log("MFB-error-logs ~ order placed ~ address geo ~", geoError.message)
  );

  // Tell the vendor to start cooking and admin staff that an order landed.
  // Previously this only ran when an admin changed an order's status, which
  // meant the vendor learned about an order only after someone had already
  // noticed it — the wrong way round. Required lazily to avoid a require cycle
  // (the admin controller reaches back into this module).
  try {
    const { notifyOrderReceived } = require("../controllers/admin/notify");
    await notifyOrderReceived(order_id);
  } catch (notifyError) {
    console.log(
      "MFB-error-logs ~ order placed ~ panel notify ~ err:",
      notifyError.message
    );
  }

  // Put the order into the rider pool. queueDeliveryJob swallows its own
  // errors — a delivery job that can't be built must never fail an order that
  // is already committed and, on the PhonePe path, already paid for.
  await queueDeliveryJob(order_id);
};

// The two payment column-sets, so no caller hand-rolls them.
const PAYMENT_COLUMNS = {
  cod: () => ({
    order_payment_type: "COD",
    order_transaction_id: "COD",
    order_amount_paid: 0,
    order_payment_status: 0,
    order_payment_received: 0,
  }),
  paid: ({ providerTxnId, amountInRupees }) => ({
    order_payment_type: "PG",
    order_transaction_id: providerTxnId,
    order_amount_paid: amountInRupees,
    order_payment_status: 1,
    order_payment_received: 1,
  }),
};

module.exports = {
  priceCart,
  createOrder,
  findOrderById,
  runPostOrderSideEffects,
  PAYMENT_COLUMNS,
  ORDER_ATTRIBUTES,
  ORDER_INCLUDES,
};
