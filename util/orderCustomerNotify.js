// What the customer hears from us, from placing an order to rating it.
//
// The rider side has always been well served — util/deliveryNotify.js fires at
// every transition — while the customer heard from us exactly twice ("placed",
// "accepted") and then went silent for the entire delivery. Both of those
// messages were also written without knowing anything about the order: no
// restaurant, no food, no picture, and a tap that landed on the order *list*.
//
// The six moments below are the whole journey. They live in one module rather
// than beside their six trigger points so the wording, the images and the
// deep-link payload stay consistent — six near-identical messages scattered
// across five files is how they drift.
//
// EVERY function here is best-effort and never throws. Each is called from a
// path that has already succeeded and must not be undone by a push: an order is
// placed, a vendor has accepted, a rider is standing at a counter. Callers are
// expected to `.catch(log)` anyway; the try/catch inside is the real guarantee.
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");
// Required as a module rather than destructured so tests can substitute
// notifyUser — the same reason util/promoNotificationSweeper.js does it.
const customerNotify = require("./customerNotify");
const { assetUrl } = require("./assetUrl");
const { haversineKm } = require("./geo");

// How close the rider has to be before we tell the customer to be ready.
//
// Sized against the once-a-minute fix the rider app sends
// (MFB-DELIVERY-PARTNER-APP/src/services/location.ts): at ~18 km/h a rider
// covers ~300 m between samples, so a tighter radius would routinely be
// stepped straight over and the notification would never fire at all.
const NEAR_DROP_KM = Number(process.env.NEAR_DROP_RADIUS_KM || 0.6);

// The timeline row that records we have already said "almost there".
//
// store_delivery_order_events is append-only and indexed on do_id, so this
// costs one indexed lookup per location fix. Deliberately NOT a new column on
// store_delivery_orders: naming a column on the DeliveryOrder model puts it in
// every existing SELECT and breaks all of them until the migration has run —
// the trap util/dispatch/columns.js exists to document.
const NEAR_DROP_EVENT = "near_drop";

/** First name only — "Suresh is bringing your order", not the full name. */
const firstName = (full) => String(full ?? "").trim().split(/\s+/)[0] || null;

/**
 * The order, its restaurant and its food, in one query.
 *
 * Raw SQL rather than the models: this needs two joins across three tables for
 * a handful of display fields, and the association path (order → business →
 * user, for the vendor's image) is longer than the query.
 */
async function loadOrderContext(orderId) {
  const [row] = await sequelize.query(
    `SELECT o.\`order_id\`, o.\`customer_id\`, o.\`vendor_id\`,
            o.\`order_prep_minutes\`,
            b.\`business_name\`, u.\`user_image\` AS \`vendor_image\`
       FROM \`store_orders\` o
       LEFT JOIN \`store_users_business\` b ON b.\`user_id\` = o.\`vendor_id\`
       LEFT JOIN \`store_users\` u ON u.\`user_id\` = o.\`vendor_id\`
      WHERE o.\`order_id\` = :orderId`,
    { replacements: { orderId }, type: QueryTypes.SELECT }
  );
  if (row == null) return null;

  const items = await sequelize.query(
    `SELECT p.\`product_name\`, p.\`product_image\`
       FROM \`store_orders_details\` d
       LEFT JOIN \`store_products\` p ON p.\`product_id\` = d.\`product_id\`
      WHERE d.\`order_id\` = :orderId
      ORDER BY d.\`order_detail_id\` ASC`,
    { replacements: { orderId }, type: QueryTypes.SELECT }
  );

  const first = items[0] ?? null;
  return {
    orderId: row.order_id,
    customerId: row.customer_id,
    prepMinutes: Number(row.order_prep_minutes) || null,
    restaurant: String(row.business_name ?? "").trim() || null,
    restaurantImage: assetUrl("vendors", row.vendor_image),
    firstItem: String(first?.product_name ?? "").trim() || null,
    firstItemImage: assetUrl("products", first?.product_image),
    itemCount: items.length,
  };
}

/**
 * "Paneer Tikka +2 more", or just "Paneer Tikka", or "Your order".
 *
 * The point of naming the food is recognition — a customer with two orders in
 * flight can tell which notification is which without opening anything.
 */
function itemSummary(ctx) {
  if (!ctx.firstItem) return "Your order";
  const others = ctx.itemCount - 1;
  return others > 0 ? `${ctx.firstItem} +${others} more` : ctx.firstItem;
}

/** " from Chai Sutta Bar", or "" when the restaurant is unknown. */
const fromRestaurant = (ctx) => (ctx.restaurant ? ` from ${ctx.restaurant}` : "");

/**
 * The one place a customer order notification is actually sent.
 *
 * `stage` rides in the data payload so the app can tell the six apart, and is
 * persisted so a tap on the in-app list days later routes the same way a tap on
 * the push would have.
 */
async function send(ctx, { stage, icon, title, body, image, focus }) {
  if (ctx?.customerId == null) return null;
  return customerNotify.notifyUser(ctx.customerId, {
    category: "orders",
    icon,
    title,
    body,
    image: image || null,
    refOrderId: ctx.orderId,
    refStage: stage,
    data: { stage, ...(focus ? { focus } : {}) },
  });
}

/** Wraps a notifier so a failed push can never reach the caller's path. */
function guard(name, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.log(`MFB ~ orderCustomerNotify ~ ${name} ~`, err.message);
      return null;
    }
  };
}

// 1. The order is in. Sent from util/orders.js the moment it is written.
const orderPlaced = guard("placed", async (orderId) => {
  const ctx = await loadOrderContext(orderId);
  if (!ctx) return null;
  return send(ctx, {
    stage: "placed",
    icon: "receipt_long",
    title: "Order placed 🎉",
    body: `${itemSummary(ctx)}${fromRestaurant(ctx)}. We'll keep you posted here.`,
    image: ctx.firstItemImage,
  });
});

// 2. The kitchen agreed, and said how long. Sent from util/orderLifecycle.js.
const orderAccepted = guard("accepted", async (orderId, prepMinutes) => {
  const ctx = await loadOrderContext(orderId);
  if (!ctx) return null;
  const minutes = Number(prepMinutes) || ctx.prepMinutes;
  return send(ctx, {
    stage: "preparing",
    icon: "restaurant",
    title: ctx.restaurant
      ? `${ctx.restaurant} is preparing your order 👨‍🍳`
      : "Your order is being prepared 👨‍🍳",
    body: minutes
      ? `${itemSummary(ctx)} · ready in about ${minutes} min.`
      : `${itemSummary(ctx)} is being prepared.`,
    image: ctx.restaurantImage,
  });
});

// 3. Somebody is bringing it. Fires from BOTH assignment paths — a rider
//    accepting an offer in the app, and an admin assigning from the panel.
const riderAssigned = guard("assigned", async (orderId, riderName) => {
  const ctx = await loadOrderContext(orderId);
  if (!ctx) return null;
  const who = firstName(riderName);
  return send(ctx, {
    stage: "assigned",
    icon: "two_wheeler",
    title: who ? `${who} will deliver your order 🛵` : "A delivery partner is on the way 🛵",
    body: `Your order${fromRestaurant(ctx)} will be picked up shortly.`,
    image: ctx.restaurantImage,
  });
});

// 4. The food is in the bag and moving.
const orderPickedUp = guard("picked_up", async (orderId, riderName) => {
  const ctx = await loadOrderContext(orderId);
  if (!ctx) return null;
  const who = firstName(riderName);
  return send(ctx, {
    stage: "picked_up",
    icon: "local_shipping",
    title: "Order picked up 🛵",
    body: who
      ? `${who} has your order${fromRestaurant(ctx)} and is on the way to you.`
      : `Your order${fromRestaurant(ctx)} is on the way to you.`,
    image: ctx.restaurantImage,
  });
});

// 5. Close enough that the customer should start moving to the door.
const riderNearby = guard("arriving", async (orderId, riderName) => {
  const ctx = await loadOrderContext(orderId);
  if (!ctx) return null;
  const who = firstName(riderName);
  return send(ctx, {
    stage: "arriving",
    icon: "location_on",
    title: "Almost there — please be ready 📍",
    body: who
      ? `${who} is about to reach you with your order${fromRestaurant(ctx)}.`
      : `Your delivery partner is about to reach you with your order${fromRestaurant(ctx)}.`,
    image: ctx.restaurantImage,
  });
});

// 6. Done — and the one moment a rating request is actually welcome.
const orderDelivered = guard("delivered", async (orderId, riderName) => {
  const ctx = await loadOrderContext(orderId);
  if (!ctx) return null;
  const who = firstName(riderName);
  return send(ctx, {
    stage: "delivered",
    icon: "star_rate",
    title: "Delivered — enjoy your meal 🎉",
    body: who ? `How was ${who}? Tap to rate your delivery.` : "Tap to rate your delivery.",
    image: ctx.firstItemImage,
    // Opens OrderTracking scrolled to the rating card rather than the top.
    focus: "rating",
  });
});

/**
 * Called on every rider location fix: is this rider nearly at the door?
 *
 * Returns { notified, reason } rather than throwing, because the caller is the
 * location endpoint the live tracking map depends on — a proximity check that
 * blew up would take the rider's position with it.
 *
 * Fires at most once per job. The check and the marker are not atomic, but the
 * only writer is a single rider's phone posting one fix a minute, so the race
 * needs two fixes from one device inside the same few milliseconds; the cost if
 * it ever happened is one duplicate notification.
 */
const checkNearDrop = guard("near_drop", async (dpId, lat, lng) => {
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return { notified: false, reason: "no fix" };
  }

  // Only once the food is aboard. Between accept and pickup the rider is
  // heading for the restaurant, and "be ready" then is simply wrong.
  const [job] = await sequelize.query(
    `SELECT \`do_id\`, \`source_order_id\`, \`drop_lat\`, \`drop_lng\`
       FROM \`store_delivery_orders\`
      WHERE \`dp_id\` = :dpId AND \`status\` = 'picked_up'
      ORDER BY \`do_id\` DESC LIMIT 1`,
    { replacements: { dpId }, type: QueryTypes.SELECT }
  );
  if (job == null) return { notified: false, reason: "no job in flight" };
  if (job.drop_lat == null || job.drop_lng == null) {
    return { notified: false, reason: "drop has no coordinates" };
  }

  const km = haversineKm(point, { lat: Number(job.drop_lat), lng: Number(job.drop_lng) });
  if (km == null || km > NEAR_DROP_KM) {
    return { notified: false, reason: "still far", km };
  }

  const [{ seen } = { seen: 0 }] = await sequelize.query(
    `SELECT COUNT(*) AS \`seen\` FROM \`store_delivery_order_events\`
      WHERE \`do_id\` = :doId AND \`status\` = :status`,
    {
      replacements: { doId: job.do_id, status: NEAR_DROP_EVENT },
      type: QueryTypes.SELECT,
    }
  );
  if (Number(seen) > 0) return { notified: false, reason: "already told them" };

  const { logOrderEvent } = require("./delivery");
  await logOrderEvent(job.do_id, dpId, NEAR_DROP_EVENT, "Rider approaching the drop");

  const { DeliveryPartner } = require("../models");
  const partner = await DeliveryPartner.findByPk(dpId, { attributes: ["dp_name"] });
  await riderNearby(job.source_order_id, partner?.dp_name);

  return { notified: true, km, do_id: job.do_id };
});

module.exports = {
  orderPlaced,
  orderAccepted,
  riderAssigned,
  orderPickedUp,
  riderNearby,
  orderDelivered,
  checkNearDrop,
  // Exported for tests — the shaping is where the bugs live, not the sending.
  _loadOrderContext: loadOrderContext,
  _itemSummary: itemSummary,
  _firstName: firstName,
  NEAR_DROP_KM,
  NEAR_DROP_EVENT,
};
