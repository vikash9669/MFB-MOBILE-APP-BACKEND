// What a delivery partner hears from us, at the five moments that matter.
//
// The counterpart to util/orderCustomerNotify.js, and built the same way: one
// module owning the wording, the images and the tap targets, so six near-
// identical messages cannot drift apart across the files that raise them.
//
// All of these go out `rich`, meaning DATA-ONLY and rendered by Notifee inside
// the app (see util/fcm.js). That is what buys the action buttons and the
// big-picture image — a notification Android draws itself can carry neither.
// The cost is that the app must be installed and its background handler
// registered, which it is (MFB-DELIVERY-PARTNER-APP/index.js).
//
// EVERY function is best-effort and never throws. Each is called from a path
// that has already committed — an approval, an assignment, a delivery — and a
// push that fails must not undo it.
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");
const deliveryNotify = require("./deliveryNotify");
const { assetUrl } = require("./assetUrl");

const money = (n) => `₹${Number(n || 0).toFixed(0)}`;
const km = (n) => `${Number(n || 0).toFixed(1)} km`;

/** Wraps a notifier so a failed push can never reach the caller's path. */
function guard(name, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.log(`MFB ~ riderNotify ~ ${name} ~`, err.message);
      return null;
    }
  };
}

/**
 * The job, its restaurant and what it pays, in one query.
 *
 * Everything the "new delivery" card shows comes from here, so the rider can
 * decide whether to move without opening anything.
 */
async function loadJobContext(doId) {
  const [job] = await sequelize.query(
    `SELECT d.\`do_id\`, d.\`dp_id\`, d.\`source_order_id\`, d.\`order_ref\`, d.\`status\`,
            d.\`pickup_name\`, d.\`pickup_lat\`, d.\`pickup_lng\`,
            d.\`drop_area\`, d.\`distance_km\`, d.\`eta_min\`,
            d.\`earn_total\`, d.\`items_count\`, d.\`payment_type\`, d.\`cash_to_collect\`,
            d.\`cash_collected\`,
            u.\`user_image\` AS \`vendor_image\`
       FROM \`store_delivery_orders\` d
       LEFT JOIN \`store_orders\` o ON o.\`order_id\` = d.\`source_order_id\`
       LEFT JOIN \`store_users\` u ON u.\`user_id\` = o.\`vendor_id\`
      WHERE d.\`do_id\` = :doId`,
    { replacements: { doId }, type: QueryTypes.SELECT }
  );
  if (job == null) return null;
  return {
    ...job,
    restaurant: String(job.pickup_name ?? "").trim() || null,
    image: assetUrl("vendors", job.vendor_image),
  };
}

/** The one place a rider notification is sent. */
function send(dpId, payload) {
  if (dpId == null) return null;
  return deliveryNotify.notifyPartner(dpId, { rich: true, ...payload });
}

// 1. Admin approved the application.
//
// `route: "refresh"` rather than a screen name, deliberately: the app's gate
// screens key off the verification status held in the access token, and that
// token still says "pending". Sending the rider to a screen would land them
// back on the waiting screen. The app has to re-read its status first — see
// the rider app's notification router.
const applicationApproved = guard("approved", async (dpId, name) => {
  const first = String(name ?? "").trim().split(/\s+/)[0];
  return send(dpId, {
    category: "system",
    icon: "verified",
    title: first ? `Congratulations, ${first}! You're approved 🎉` : "Congratulations! You're approved 🎉",
    body: "Your profile has been verified. Go online and start delivering smiles.",
    route: "refresh",
    actions: [{ id: "refresh", title: "Start delivering" }],
    data: { type: "verification", status: "approved" },
  });
});

// 2. An admin assigned a delivery by hand.
//
// The old message was "Order #N has been assigned to you. Open the app to
// start" — which told a rider nothing they could act on. Everything needed to
// decide whether to move is now on the card.
const deliveryAssigned = guard("assigned", async (doId) => {
  const job = await loadJobContext(doId);
  if (!job) return null;
  const where = [job.restaurant, job.drop_area].filter(Boolean).join("  →  ");
  return send(job.dp_id, {
    category: "orders",
    icon: "assignment",
    title: `New delivery · ${money(job.earn_total)}`,
    body: [where, `${km(job.distance_km)} · about ${job.eta_min || "?"} min`]
      .filter(Boolean)
      .join("\n"),
    image: job.image,
    route: `delivery:${job.do_id}`,
    actions: [
      { id: "open", title: "Open delivery" },
      { id: "navigate", title: "Navigate" },
    ],
    // The maps destination for the Navigate button — the app opens these
    // directly rather than routing through a screen of ours.
    data: {
      type: "order_assigned",
      do_id: String(job.do_id),
      order_ref: String(job.order_ref ?? ""),
      ...(job.pickup_lat != null ? { pickup_lat: String(job.pickup_lat) } : {}),
      ...(job.pickup_lng != null ? { pickup_lng: String(job.pickup_lng) } : {}),
    },
  });
});

// 3. The restaurant has finished cooking.
//
// Nothing told the rider this before. A rider who accepted while the food was
// still being made had no signal at all that it was ready — they either
// guessed, or sat outside the restaurant waiting.
const orderPrepared = guard("prepared", async (doId) => {
  const job = await loadJobContext(doId);
  if (!job) return null;
  return send(job.dp_id, {
    category: "orders",
    icon: "restaurant",
    title: "Order is ready for pickup 🍽️",
    body: job.restaurant
      ? `${job.restaurant} has finished your order${job.items_count ? ` · ${job.items_count} item(s)` : ""}. Collect it now.`
      : "The restaurant has finished the order. Collect it now.",
    image: job.image,
    route: `delivery:${job.do_id}`,
    actions: [
      { id: "open", title: "Open delivery" },
      { id: "navigate", title: "Navigate to store" },
    ],
    data: {
      type: "order_ready",
      do_id: String(job.do_id),
      ...(job.pickup_lat != null ? { pickup_lat: String(job.pickup_lat) } : {}),
      ...(job.pickup_lng != null ? { pickup_lng: String(job.pickup_lng) } : {}),
    },
  });
});

// 4. Delivered, and the money is accounted for.
//
// Replaces a bare "Earned ₹X". For a COD job the cash the rider is now
// carrying matters as much as the earning — it is money they owe back, and
// dp_cash_in_hand gates whether they can be offered more work.
const orderDelivered = guard("delivered", async (doId) => {
  const job = await loadJobContext(doId);
  if (!job) return null;
  const cod = String(job.payment_type).toUpperCase() === "COD" && Number(job.cash_to_collect) > 0;
  const collected = cod && Boolean(job.cash_collected);
  return send(job.dp_id, {
    category: "payments",
    icon: "payments",
    title: `Delivered · you earned ${money(job.earn_total)} 🎉`,
    body: collected
      ? `${money(job.cash_to_collect)} cash collected from the customer. Your earning is in your wallet.`
      : cod
        ? `Cash was not collected on this order. Your earning of ${money(job.earn_total)} is in your wallet.`
        : "Paid online — nothing to collect. Your earning is in your wallet.",
    route: "earnings",
    actions: [{ id: "earnings", title: "View earnings" }],
    data: { type: "order_delivered", do_id: String(job.do_id) },
  });
});

// 5. Online, but the phone has stopped reporting where it is.
//
// The app raises its own version of this the moment it cannot get a fix
// (services/shiftAlerts.ts), which is faster and more accurate than anything
// the server can tell. This exists for the case the app cannot cover: it was
// force-quit, or the OS killed it, while the partner is still marked online.
// Then nothing on the device is running to notice, and the only evidence is a
// location that stopped arriving.
const locationStale = guard("location_stale", async (dpId, minutesStale) => {
  return send(dpId, {
    category: "system",
    icon: "location_off",
    title: "We've lost your location 📍",
    body:
      `You're online but we haven't had your location for ${Math.round(minutesStale)} minutes. ` +
      "Open the app and check location is on, or you'll stop getting orders.",
    route: "refresh",
    actions: [{ id: "refresh", title: "Open app" }],
    data: { type: "location_stale" },
  });
});

module.exports = {
  applicationApproved,
  deliveryAssigned,
  orderPrepared,
  orderDelivered,
  locationStale,
  _loadJobContext: loadJobContext,
};
