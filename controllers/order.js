const { Op, QueryTypes } = require("sequelize");
const sequelize = require("../util/database");
const { buildTracking, loadTrackingJob } = require("../util/orderTracking");
const { ratingForDelivery } = require("../util/ratings");
const { ratingsReady } = require("../util/ratingColumns");
const {
  StoreOrders,
  StoreOrderDetails,
  Product,
  Business,
  User,
} = require("../models");

const { getCouponCodeDetails, listAvailableCoupons } = require("../util/coupon");
const {
  priceCart,
  createOrder: createOrderRow,
  findOrderById,
  runPostOrderSideEffects,
  PAYMENT_COLUMNS,
} = require("../util/orders");

/**
 * Lifecycle columns the order model deliberately does not name.
 *
 * Returns {} before the migration, which the stage machine handles: no prep
 * promise simply means falling back to a default estimate.
 */
async function loadLifecycleFields(orderId) {
  const { ordersReady } = require("../util/lifecycleColumns");
  if (!(await ordersReady())) return {};

  const [row] = await sequelize.query(
    "SELECT `order_accepted_time`, `order_prep_minutes`, `order_cancel_reason` " +
      "FROM `store_orders` WHERE `order_id` = :orderId",
    { replacements: { orderId }, type: QueryTypes.SELECT }
  );
  return row ?? {};
}

/**
 * GET /user/orders/:id/route — the line to draw on the customer's map.
 *
 * Deliberately a separate endpoint from the rider's /delivery/orders/:id/route.
 * That one authorises by "is this your job"; this one by "is this your order".
 * Reusing it would have meant either widening rider auth to customers or
 * handing customers a rider token, and both are worse than fifty lines.
 *
 * The leg follows the food: before pickup the interesting line is
 * restaurant→door, after pickup it is rider→door. Returning { route: null } is
 * a normal answer — the screen falls back to a straight line rather than an
 * empty map.
 */
// The two ends of a delivery, from whichever record actually knows them.
//
// The delivery job carries both once dispatch has created one — but that does
// not happen until the restaurant accepts, and the customer wants to see where
// their food is coming from before then. So this falls back to the source
// records: the restaurant is a store_users row with a pin its vendor set in the
// panel, and the delivery address stores its own coordinates.
//
// Returns nulls rather than throwing. Every caller treats a missing end as
// "draw less", never as an error — a tracking screen with no map is still a
// working tracking screen.
async function orderEndpoints(order, job, businessName) {
  let pickup = null;
  let drop = null;

  if (job?.pickup_lat != null && job?.pickup_lng != null) {
    pickup = { lat: Number(job.pickup_lat), lng: Number(job.pickup_lng), name: job.pickup_name };
  }
  if (job?.drop_lat != null && job?.drop_lng != null) {
    drop = { lat: Number(job.drop_lat), lng: Number(job.drop_lng) };
  }

  if (pickup == null && order?.vendor_id != null) {
    const { readPin } = require("../util/vendorColumns");
    const pin = await readPin(order.vendor_id);
    if (pin) pickup = { lat: pin.lat, lng: pin.lng, name: businessName || null };
  }

  // Label + formatted address for the drop pin, read from the saved address
  // regardless of whether the coordinates above already came from the
  // delivery job — a dispatched job's drop_lat/lng is just a copy of this
  // same address and carries no label of its own, so without this a
  // dispatched order's drop pin would go unlabelled while an undispatched
  // one's would not.
  if (order?.address_id != null) {
    const { geoReady } = require("../util/addressColumns");
    if (await geoReady()) {
      const [row] = await sequelize.query(
        "SELECT `delivery_lat`, `delivery_lng`, `delivery_label`, `delivery_formatted` " +
          "FROM `store_users_shipping_address` WHERE `delivery_id` = :id LIMIT 1",
        { replacements: { id: order.address_id }, type: QueryTypes.SELECT }
      );
      if (drop == null && row?.delivery_lat != null && row?.delivery_lng != null) {
        drop = { lat: Number(row.delivery_lat), lng: Number(row.delivery_lng) };
      }
      if (drop != null && row != null) {
        drop.name = row.delivery_label || "Delivery address";
        drop.formatted = row.delivery_formatted || null;
      }
    }
  }

  return { pickup, drop };
}

const getOrderRoute = async (req, res) => {
  try {
    const order = await StoreOrders.findOne({
      where: { order_id: req.params.id, customer_id: req.user.user_id },
      attributes: ["order_id", "vendor_id", "address_id"],
      raw: true,
    });
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }

    // No early return on a missing job any more. Before dispatch creates one,
    // the restaurant-to-door route is still the right thing to draw, and it is
    // the stretch the customer is looking at longest.
    const job = await loadTrackingJob(order.order_id);
    const { pickup: pickupPoint, drop } = await orderEndpoints(order, job, null);

    let from = pickupPoint;
    if (job?.status === "picked_up" && job.dp_id != null) {
      const { DeliveryPartner } = require("../models");
      const partner = await DeliveryPartner.findByPk(job.dp_id, {
        attributes: ["dp_lat", "dp_lng"],
        raw: true,
      });
      if (partner?.dp_lat != null && partner?.dp_lng != null) {
        from = { lat: Number(partner.dp_lat), lng: Number(partner.dp_lng) };
      }
    }

    if (from == null || drop == null) {
      return res.json({ route: null, reason: "missing coordinates" });
    }

    const { directions } = require("../util/geo");
    const route = await directions(from, drop);
    res.json({ route, from, to: drop });
  } catch (err) {
    console.log("MFB-error-logs ~ customer order route ~", err.message);
    // Never 500 a map. The screen is useful without it.
    res.json({ route: null, reason: "unavailable" });
  }
};

const getActiveOrders = async (req, res) => {
  const { user_id } = req.user;
  // How far back an order can be and still count as "in flight".
  //
  // This was one hour, while the comment below it claimed 24 — and one hour is
  // wrong now that the tracking screen exists. An order that takes longer than
  // that is precisely the one a customer is anxious about, and it would lose
  // its tracking screen at the worst possible moment. Terminal statuses are
  // already excluded by the where clause, so the window only needs to be long
  // enough to cover any delivery that is genuinely still happening.
  const ACTIVE_WINDOW_HOURS = Number(process.env.ACTIVE_ORDER_WINDOW_HOURS || 24);
  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_HOURS * 60 * 60 * 1000);
  // How long a finished order keeps showing its outcome before dropping into
  // history. Long enough to read "declined, refund on its way"; short enough
  // that yesterday's dinner isn't still on the home screen.
  const TERMINAL_WINDOW_MIN = Number(process.env.TERMINAL_ORDER_WINDOW_MIN || 90);
  const terminalSince = new Date(Date.now() - TERMINAL_WINDOW_MIN * 60 * 1000);
  try {
    const order = await StoreOrders.findOne({
      attributes: [
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
      ],
      where: {
        customer_id: user_id,
        order_received_time: { [Op.gte]: activeSince },
        // Delivered (5) and Cancelled (6) used to be excluded outright. That
        // made the tracking screen's two most important endings unreachable:
        // a customer whose order the restaurant declined saw the screen go
        // blank instead of being told what happened — and told about their
        // refund. So terminal orders are still returned, but only while the
        // customer is plausibly still looking at the screen; after that they
        // belong in order history, not in "active".
        [Op.or]: [
          { order_status: { [Op.notIn]: [5, 6] } },
          {
            order_status: { [Op.in]: [5, 6] },
            order_received_time: { [Op.gte]: terminalSince },
          },
        ],
      },
      order: [["order_id", "DESC"]],
      include: [
        {
          model: StoreOrderDetails,
          attributes: [
            "order_detail_id",
            "product_id",
            "product_qty",
            "product_mrp",
            // "product_name",
            "product_price",
            "product_discount",
            "product_total",
            "product_available",
          ],
          include: {
            model: Product,
            attributes: ["product_name"],
          },
        },
        {
          model: Business,
          attributes: ["business_name", "user_id"],
        },
      ],
    });

    if (order == null) {
      res.status(200).json({
        order: null,
        rider: null,
      });
      return;
    }
    // Scoped, deliberately. This row goes out to the customer in the response
    // below, and store_users holds user_password — an unscoped findOne put the
    // panel rider's password hash into the tracking payload of every customer
    // whose order had one assigned. The screen only ever needed a name and a
    // number.
    const rider = await User.findOne({
      attributes: ["user_id", "user_name", "user_phone", "user_phone_1"],
      where: {
        user_id: order.rider_id,
      },
    });

    // The delivery code the customer reads out at the door.
    //
    // It was generated on every delivery job and checked at /verify-delivery,
    // but never shown to the person expected to say it — so no delivery could
    // be completed. This is the one OTP worth keeping: it is what stops a rider
    // marking an order delivered that never arrived.
    //
    // Only released once a rider actually has the order. Handing it out at
    // placement would let it be screenshotted and shared long before anyone is
    // at the door, which defeats the point.
    let deliveryOtp = null;
    let deliveryStage = null;
    let tracking = null;
    let pickup = null;
    let drop = null;
    try {
      const job = await loadTrackingJob(order.order_id);

      if (job && ["accepted", "picked_up"].includes(job.status)) {
        deliveryOtp = job.drop_otp;
        deliveryStage = job.status;
      }

      // The rider's own record, for a live position. Separate from `rider`
      // above, which is the panel-side store_users row and has no coordinates.
      let partner = null;
      if (job?.dp_id != null) {
        const { DeliveryPartner } = require("../models");
        partner = await DeliveryPartner.findByPk(job.dp_id, {
          // dp_phone so the customer can call the person carrying their food.
          // buildTracking decides whether it is actually released — it is not
          // handed out before the rider holds the order, or after delivery.
          attributes: ["dp_id", "dp_name", "dp_phone", "dp_lat", "dp_lng"],
          raw: true,
        });
      }

      const lifecycle = await loadLifecycleFields(order.order_id);
      tracking = buildTracking({
        order: { ...order.toJSON(), ...lifecycle },
        job,
        partner,
        riderUser: rider,
      });

      // Map endpoints. Sent whenever known so the screen can draw the route
      // without a second round-trip; the rider's own position is gated inside
      // buildTracking and is not part of this.
      //
      // Same resolver the route endpoint uses, so the pins and the line drawn
      // between them can never come from different records.
      ({ pickup, drop } = await orderEndpoints(
        order,
        job,
        // belongsTo with no alias and a model named "business", so the include
        // lands on order.business.
        order.business?.business_name || null
      ));
    } catch (err) {
      // Tracking is an enhancement. A customer must still be able to read
      // their order if any part of the delivery side is unavailable.
      console.log("MFB ~ active order ~ tracking ~", err.message);
    }

    // Whether this delivery can be rated, and what was said if it already has
    // been. Built here rather than on the client because "can I rate this?" is
    // three facts the client does not hold: the job is delivered, it has a
    // rider, and the schema for ratings exists at all.
    let rating = null;
    try {
      const job = await loadTrackingJob(order.order_id);
      if (job?.status === "delivered" && job.dp_id != null && (await ratingsReady())) {
        const existing = await ratingForDelivery(job.do_id);
        rating = {
          do_id: job.do_id,
          can_rate: true,
          submitted: existing != null,
          stars: existing?.stars ?? null,
          tags: existing?.tags ?? [],
          comment: existing?.comment ?? null,
        };
      }
    } catch (err) {
      // Never let the rating block cost someone their order screen.
      console.log("MFB ~ active order ~ rating ~", err.message);
    }

    res.status(200).json({
      order,
      rider,
      delivery_otp: deliveryOtp,
      delivery_stage: deliveryStage,
      tracking,
      rating,
      pickup,
      drop,
      // So the client's clock skew cannot make a countdown lie.
      server_time: Date.now(),
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching the orders" });
  }
};

const getOrdersByCustomerId = async (req, res) => {
  const { user_id } = req.user;

  try {
    const orders = await StoreOrders.findAll({
      attributes: [
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
      ],
      where: {
        customer_id: user_id,
      },
      order: [["order_received_time", "DESC"]],
      include: [
        {
          model: StoreOrderDetails,
          attributes: [
            "order_detail_id",
            "product_id",
            "product_qty",
            "product_mrp",
            // "product_name",
            "product_price",
            "product_discount",
            "product_total",
            "product_available",
          ],
          include: {
            model: Product,
            attributes: ["product_name"],
          },
        },
        {
          model: Business,
          attributes: ["business_name", "user_id"],
        },
      ],
    });

    // Rating state, attached to the history list.
    //
    // The tracking screen carries the rating card, but a delivered order only
    // stays on that screen for TERMINAL_ORDER_WINDOW_MIN (90 minutes) — after
    // which the customer had no way to rate at all, even though the API accepts
    // ratings for RATING_WINDOW_HOURS (72). History is where someone goes to
    // find last night's order, so it is where the second chance belongs.
    //
    // One query for the whole page rather than one per order.
    let withRating = orders;
    try {
      if (await ratingsReady()) {
        const ids = orders.map((o) => o.order_id);
        const rows = ids.length
          ? await sequelize.query(
              `SELECT d.\`source_order_id\` order_id, d.\`do_id\`, d.\`dp_id\`,
                      d.\`status\`, d.\`delivered_at\`, r.\`stars\`
                 FROM \`store_delivery_orders\` d
                 LEFT JOIN \`store_delivery_ratings\` r ON r.\`do_id\` = d.\`do_id\`
                WHERE d.\`source_order_id\` IN (:ids)`,
              { replacements: { ids }, type: QueryTypes.SELECT }
            )
          : [];
        const byOrder = new Map(rows.map((r) => [Number(r.order_id), r]));
        const windowMs = Number(process.env.RATING_WINDOW_HOURS || 72) * 3600000;

        withRating = orders.map((o) => {
          const job = byOrder.get(Number(o.order_id));
          const plain = o.toJSON();
          if (!job || job.status !== "delivered" || job.dp_id == null) {
            return { ...plain, rating: null };
          }
          const open =
            !job.delivered_at ||
            Date.now() - new Date(job.delivered_at).getTime() <= windowMs;
          return {
            ...plain,
            rating: {
              do_id: job.do_id,
              can_rate: open || job.stars != null,
              submitted: job.stars != null,
              stars: job.stars != null ? Number(job.stars) : null,
              // False once the window has closed, so the app can show the score
              // it was given without offering to change it.
              editable: open,
            },
          };
        });
      }
    } catch (err) {
      // History must render even if the delivery side is unavailable.
      console.log("MFB ~ order history ~ rating ~", err.message);
    }

    res.status(200).json(withRating);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching the orders" });
  }
};

// COD checkout. The paid path lives in controllers/payment.js — both share the
// pricing and insert logic in util/orders.js.
const createOrder = async (req, res) => {
  const { user_id } = req.user;
  const {
    address_id,
    product_ids_with_quantity,
    business_user_id,
    coupon_code,
    platform,
  } = req.body || {};

  // The cart is an OBJECT keyed by product id, not an array — util/orders.js
  // reads it with Object.keys(). An earlier version of this guard tested
  // Array.isArray() and so rejected every real order with a 400, which on the
  // app looked like the Place Order button doing nothing at all.
  const cartIsUsable =
    product_ids_with_quantity != null &&
    typeof product_ids_with_quantity === "object" &&
    !Array.isArray(product_ids_with_quantity) &&
    Object.keys(product_ids_with_quantity).length > 0;

  if (!address_id || !business_user_id || !cartIsUsable) {
    return res.status(400).json({
      message: "address_id, business_user_id and a non-empty cart are required",
    });
  }

  try {
    const pricing = await priceCart({
      address_id,
      product_ids_with_quantity,
      business_user_id,
      coupon_code,
      platform,
      user_id,
    });

    const newOrder = await createOrderRow({
      user_id,
      business_user_id,
      address_id,
      product_ids_with_quantity,
      pricing,
      // Matches the legacy PHP contract exactly (txn 'COD', unpaid). The rider
      // screen keys off order_payment_status === 0 to show "collect cash".
      payment: PAYMENT_COLUMNS.cod(),
    });

    const orderResponse = await findOrderById(newOrder.order_id);

    await runPostOrderSideEffects({
      user_id,
      order_id: newOrder.order_id,
      total_amount: pricing.payable,
    });

    res
      .status(201)
      .json({ message: "Order created successfully", order: orderResponse });
  } catch (error) {
    // Same rule as the online path: a cart problem the customer can act on is
    // a 400 carrying the reason ("This restaurant does not deliver to the
    // selected address" is the one that matters most here), while a real fault
    // stays a generic 500. See util/orders.js::cartRefusal.
    if (error?.clientSafe) {
      return res.status(400).json({ message: error.message });
    }
    console.error(error);
    res
      .status(500)
      .json({ message: "Error creating order" });
  }
};

// Public preview — no req.user here (see util/coupon.js's note on why
// usage-limit enforcement happens only at order creation, not here).
const getCouponCodeDiscountDetails = async (req, res) => {
  const { code, order_amount, platform, business_user_id, product_ids } = req.body;
  const result = await getCouponCodeDetails({
    code,
    orderAmount: Number(order_amount),
    platform,
    businessUserId: business_user_id,
    productIds: Array.isArray(product_ids) ? product_ids : undefined,
  });
  res.status(200).json(result);
};

// POST /user/coupons/available
// { business_user_id, product_ids, order_amount } -> the offers this cart can use.
//
// Authenticated, unlike the /coupon preview beside it, and that is the point:
// the per-user usage limit can only be enforced with an identity, so an
// anonymous version would advertise codes the customer has already spent. See
// util/coupon.js::usageRemaining.
const getAvailableCoupons = async (req, res) => {
  try {
    const { business_user_id, product_ids, order_amount } = req.body || {};

    // The cart's subtotal is what every threshold and percentage is computed
    // against, so without it the answer would be a guess. Zero is a legitimate
    // value (an empty cart shows only what the customer could work towards).
    const orderAmount = Number(order_amount);
    if (!Number.isFinite(orderAmount) || orderAmount < 0) {
      return res.status(400).json({ message: "order_amount is required" });
    }

    const coupons = await listAvailableCoupons({
      orderAmount,
      businessUserId: business_user_id,
      productIds: Array.isArray(product_ids) ? product_ids : undefined,
      userId: req.user?.user_id,
    });

    res.status(200).json({ coupons });
  } catch (err) {
    console.log("MFB-error-logs ~ available coupons ~ err:", err);
    // Deliberately a 200 with nothing rather than an error: this list is a
    // convenience beside a coupon box that still works by hand. A checkout
    // screen must not break because the offers panel could not be built.
    res.status(200).json({ coupons: [] });
  }
};

module.exports = {
  getOrdersByCustomerId,
  createOrder,
  getActiveOrders,
  getAvailableCoupons,
  getOrderRoute,
  getCouponCodeDiscountDetails,
};
