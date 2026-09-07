// Turns a placed customer order into a delivery job riders can be offered.
//
// This is the bridge that didn't exist: store_orders and store_delivery_orders
// were completely disconnected, so every delivery job in the system came from
// the demo seeder and a real rider would never see a real order. createJobForOrder
// runs from the post-order side effects, which both checkout paths go through
// (COD in controllers/order.js, PhonePe in controllers/payment.js).
//
// Nothing here may fail an order that is already committed and possibly already
// paid for. Every path is caught and logged; a job that can't be built just
// doesn't get built, and the customer's order stands either way.
const {
  StoreOrders,
  StoreOrderDetails,
  Business,
  Address,
  User,
  Location,
  DeliveryOrder,
} = require("../models");
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");
const { num, genOtp } = require("./delivery");
const { geocode, roadDistanceKm, isGeocodingConfigured } = require("./geo");
const { addressAttributes } = require("./addressColumns");
const { readPin } = require("./vendorColumns");
const { dispatchReady } = require("./dispatch/columns");

// Rider pay for a job. Deliberately env-tunable: these are commercial numbers
// that will change, and they shouldn't need a deploy to do it.
const payConfig = () => ({
  base: num(process.env.DELIVERY_EARN_BASE, 25),
  perKm: num(process.env.DELIVERY_EARN_PER_KM, 6),
  // Distance pay starts beyond this — short hops earn the base only.
  freeKm: num(process.env.DELIVERY_EARN_FREE_KM, 2),
});

// City riding averages ~20 km/h door to door, so ~3 min per km, plus the wait
// at the restaurant.
const MIN_PER_KM = 3;
const DEFAULT_READY_MIN = 4;

const round2 = (n) => Math.round(n * 100) / 100;

// Splits earnings the way the app renders them (base / distance / surge / tip).
const computeEarnings = (distanceKm) => {
  const { base, perKm, freeKm } = payConfig();
  const billableKm = Math.max(0, (distanceKm ?? 0) - freeKm);
  const distancePay = round2(billableKm * perKm);
  return {
    earn_base: base,
    earn_distance: distancePay,
    earn_surge: 0,
    earn_tip: 0,
    earn_total: round2(base + distancePay),
  };
};

// Builds the two addresses a job needs. The restaurant's address lives on its
// store_users row (store_users_business holds no address at all); the customer's
// is the shipping address the order was placed against.
// store_users.user_city and store_users_shipping_address.delivery_city hold a
// store_locations id, not a place name — feeding the raw value to a geocoder
// sends it the string "101", which matches nothing. Resolve to the real name.
const locationName = async (id) => {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  const loc = await Location.findByPk(numeric);
  return loc?.location_name || null;
};

const resolveEndpoints = async (order) => {
  const [business, vendorUser, address, customer, kitchenPin] = await Promise.all([
    Business.findOne({ where: { user_id: order.vendor_id } }),
    User.findByPk(order.vendor_id),
    // Named attributes, because the map columns may not exist yet — see
    // util/addressColumns.js. A blind SELECT * here would fail the whole job.
    Address.findByPk(order.address_id, { attributes: await addressAttributes() }),
    User.findByPk(order.customer_id),
    // Raw SQL behind a schema probe, for the same reason: store_users is the
    // login table and its pin columns are not on the User model.
    readPin(order.vendor_id),
  ]);

  const [pickupCity, dropCity] = await Promise.all([
    locationName(vendorUser?.user_city),
    locationName(address?.delivery_city),
  ]);

  const pickup = {
    name: business?.business_name || vendorUser?.user_name || "Restaurant",
    address: vendorUser?.user_address || null,
    area: pickupCity,
    phone: vendorUser?.user_phone || null,
    // Postal code, not a map pin — `point` below is the map pin. The two names
    // sit next to each other here, so keep them distinct.
    pin: vendorUser?.user_zip || null,
    landmark: vendorUser?.user_landmark || null,
    // Where the kitchen actually is, when someone has dropped a pin for it.
    // Same precedence as the customer's saved address below: a human placing a
    // marker beats a geocoder reading a street line, and dispatch scores riders
    // by distance to this point, so the difference picks a different rider.
    point: kitchenPin ? { lat: kitchenPin.lat, lng: kitchenPin.lng } : null,
  };

  // The pin the customer dropped when they saved the address. When it's there
  // it beats anything geocoding can produce: it is where they said the door is,
  // not where Google thinks the street line points.
  const pinned =
    address?.delivery_lat != null && address?.delivery_lng != null
      ? { lat: Number(address.delivery_lat), lng: Number(address.delivery_lng) }
      : null;

  const drop = {
    name: customer?.user_name || "Customer",
    // delivery_house is the flat/floor, which is the most useful line on a
    // doorstep, so lead with it when the customer gave one.
    address: [address?.delivery_house, address?.delivery_address]
      .filter(Boolean)
      .join(", ") || null,
    point: pinned,
    // What the rider sees as the locality. The landmark is more useful on the
    // doorstep than the city name, so prefer it and fall back to the city.
    area: address?.delivery_landmark || dropCity,
    // The address carries its own phone — that's the number for this delivery,
    // which isn't necessarily the account's.
    phone: address?.delivery_phone || customer?.user_phone || null,
    pin: address?.delivery_pin || null,
    landmark: address?.delivery_landmark || null,
    city: dropCity,
    note: null,
  };

  return { pickup, drop };
};

// Places both ends on the map. Runs them together — one order shouldn't wait
// on two sequential round trips to Google.
//
// Neither end is geocoded when it already has a pin of its own. For the drop
// that is every address saved before the app's map picker existed, or typed by
// hand; for the pickup it is every kitchen an admin or vendor has not placed on
// the map yet. A pin costs nothing, does not expire, and lands on the door
// rather than the middle of the street.
const locate = async (pickup, drop) => {
  const [pickupPoint, dropPoint] = await Promise.all([
    pickup.point ??
      geocode([pickup.address, pickup.landmark, pickup.area, pickup.pin], {
        pincode: pickup.pin,
      }),
    drop.point ??
      geocode([drop.address, drop.landmark, drop.city, drop.pin], {
        pincode: drop.pin,
      }),
  ]);
  return { pickupPoint, dropPoint };
};

// Creates the delivery job for a customer order, or returns null when there's
// nothing to create. Idempotent: a second call for the same order is a no-op,
// which matters because the PhonePe path can be re-entered on callback retries.
async function createJobForOrder(orderId) {
  const existing = await DeliveryOrder.findOne({
    where: { source_order_id: orderId },
  });
  if (existing != null) {
    return existing;
  }

  const order = await StoreOrders.findByPk(orderId);
  if (order == null) {
    return null;
  }

  const { pickup, drop } = await resolveEndpoints(order);
  const { pickupPoint, dropPoint } = await locate(pickup, drop);

  if (!isGeocodingConfigured()) {
    console.log(
      "MFB-error-logs ~ dispatch ~ GOOGLE_MAPS_API_KEY not set; job",
      orderId,
      "created without map coordinates"
    );
  }

  // Falls back to null when either end couldn't be placed — the rider then sees
  // the addresses as text, which is what they had before any of this existed.
  const distanceKm = roadDistanceKm(pickupPoint, dropPoint);

  const items = await StoreOrderDetails.findAll({
    where: { order_id: orderId },
    attributes: ["product_qty"],
    raw: true,
  });
  const itemsCount = items.reduce((sum, i) => sum + num(i.product_qty, 1), 0);

  const isCod = order.order_payment_type === "COD";
  // Goods + delivery − discount, matching what the cart charged.
  const payable =
    num(order.order_amount) +
    num(order.delivery_charges) -
    num(order.order_discount);

  return DeliveryOrder.create({
    source_order_id: order.order_id,
    order_ref: String(order.order_id),
    status: "offered",
    dp_id: null,

    pickup_name: pickup.name,
    pickup_address: pickup.address,
    pickup_area: pickup.area,
    pickup_phone: pickup.phone,
    pickup_lat: pickupPoint?.lat ?? null,
    pickup_lng: pickupPoint?.lng ?? null,
    pickup_otp: genOtp(),
    // Distance from the rider to the restaurant is per-rider, so it's filled in
    // when the job is offered rather than stored here.
    pickup_distance_km: null,
    ready_in_min: DEFAULT_READY_MIN,

    drop_name: drop.name,
    drop_address: drop.address,
    drop_area: drop.area,
    drop_phone: drop.phone,
    drop_lat: dropPoint?.lat ?? null,
    drop_lng: dropPoint?.lng ?? null,
    drop_otp: genOtp(),
    drop_note: drop.note,

    items_count: Math.max(1, itemsCount),
    distance_km: distanceKm ?? 0,
    eta_min: Math.max(
      10,
      Math.round((distanceKm ?? 0) * MIN_PER_KM) + DEFAULT_READY_MIN
    ),

    payment_type: isCod ? "COD" : "PG",
    cash_to_collect: isCod ? payable : 0,
    cash_collected: false,

    ...computeEarnings(distanceKm),

    // A JS Date, deliberately, and NOT fn("UTC_TIMESTAMP") — which is the
    // opposite of the rule the rest of dispatch follows, for a reason.
    //
    // The connection timezone is +05:30, so this value makes a symmetric round
    // trip: Sequelize writes it as IST wall clock and reads it back through the
    // same offset, giving the correct instant. The columns written with
    // UTC_TIMESTAMP() do NOT: MySQL stores true UTC, the driver reads it as if
    // it were IST, and the value arrives in JS 5h30m early. That is why one row
    // reports `offered_at: 12:19Z` beside `dispatch_at: 06:49Z` — offered_at is
    // the one telling the truth.
    //
    // Inside SQL the UTC_TIMESTAMP() columns only ever meet each other, so
    // dispatch timing is correct; the skew appears only on the way out to JS.
    // Anything derived from those columns for a client must therefore cross the
    // wire as a duration — see deadlineFor() in util/dispatch/offers.js.
    offered_at: new Date(),
  });
}

/**
 * Parks a freshly built job so the engine will not offer it yet.
 *
 * The job row is created when the customer orders, but the restaurant has not
 * accepted at that point. Offering it immediately would send a rider to a
 * kitchen that may yet decline — so with the engine live the job is created in
 * 'waiting' with no dispatch_at, which matches neither the "unscheduled" nor
 * the "due" query in the tick. It sits inert until scheduleForSourceOrder is
 * called from the vendor's accept.
 *
 * Pre-migration this is a no-op and the old open-pool behaviour continues.
 */
async function parkUntilAccepted(job) {
  if (job == null) return;
  if (!(await dispatchReady())) return;
  await sequelize.query(
    `UPDATE \`store_delivery_orders\`
        SET \`dispatch_state\` = 'waiting', \`dispatch_at\` = NULL
      WHERE \`do_id\` = :doId`,
    { replacements: { doId: job.do_id }, type: QueryTypes.UPDATE }
  );
}

/**
 * Starts the dispatch clock for an order the restaurant has just accepted.
 *
 * prepMinutes is the vendor's own promise, captured on the accept screen — the
 * best signal available for when the food will actually be ready, and the whole
 * reason dispatch can be timed rather than guessed.
 */
async function scheduleForSourceOrder(sourceOrderId, { prepMinutes, acceptedAt } = {}) {
  try {
    if (!(await dispatchReady())) return null;

    const job = await DeliveryOrder.findOne({
      where: { source_order_id: sourceOrderId, status: "offered", dp_id: null },
      raw: true,
    });
    if (job == null) return null;

    // scheduleJob only writes where dispatch_state IS NULL, so clear the park
    // first — this is the transition from "waiting on the kitchen" to "on the
    // clock".
    await sequelize.query(
      "UPDATE `store_delivery_orders` SET `dispatch_state` = NULL WHERE `do_id` = :doId",
      { replacements: { doId: job.do_id }, type: QueryTypes.UPDATE }
    );

    const { scheduleJob } = require("./dispatch/engine");
    return await scheduleJob(job, { prepMinutes, acceptedAt: acceptedAt ?? new Date() });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch ~ scheduleForSourceOrder ~", err.message);
    return null;
  }
}

/**
 * The food is ready now — find a rider immediately.
 *
 * scheduleForSourceOrder works backwards from the vendor's prep promise so the
 * rider arrives as the food does. That promise is an estimate, and the kitchen
 * is the authority on when it is actually wrong: a vendor marking "Ready to
 * Ship" is saying the bag is on the counter. Waiting out the remainder of an
 * estimate at that point just leaves food going cold.
 *
 * So this overrides whatever the engine had planned and makes the job due on
 * the next tick. Unlike scheduleJob it deliberately does NOT require
 * `dispatch_state IS NULL` — the whole point is to overrule an existing plan.
 *
 * Two things it must not disturb:
 *   - a job a rider has already taken (dp_id set, status past 'offered');
 *   - a job currently out with a rider ('searching'), whose offer is still
 *     live — re-dating that would orphan the outstanding offer. Those are left
 *     alone; the offer either lands or expires and the ladder continues.
 *
 * Best-effort and never throws: a vendor's status change must succeed even if
 * dispatch cannot.
 */
/**
 * Tells the rider who already holds this job that the food is ready.
 *
 * The companion to dispatchNowForSourceOrder, which deliberately only looks at
 * jobs nobody has taken. A rider who accepted while the kitchen was still
 * cooking is in the opposite position: they have the job and no idea when to
 * walk in for it. Only 'accepted' qualifies — 'picked_up' means they already
 * have the bag, and telling them it is ready then is noise.
 *
 * Never throws; a vendor's status change must not depend on it.
 */
async function notifyAssignedRiderReady(sourceOrderId) {
  try {
    const job = await DeliveryOrder.findOne({
      where: { source_order_id: sourceOrderId, status: "accepted" },
      attributes: ["do_id", "dp_id"],
      raw: true,
    });
    if (job == null || job.dp_id == null) return null;

    const riderNotify = require("./riderNotify");
    await riderNotify.orderPrepared(job.do_id);
    return job.do_id;
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch ~ notifyAssignedRiderReady ~", err.message);
    return null;
  }
}

async function dispatchNowForSourceOrder(sourceOrderId) {
  try {
    if (!(await dispatchReady())) return null;

    const job = await DeliveryOrder.findOne({
      where: { source_order_id: sourceOrderId, status: "offered", dp_id: null },
      raw: true,
    });
    if (job == null) return null;

    const [, changed] = await sequelize.query(
      `UPDATE \`store_delivery_orders\`
          SET \`dispatch_at\` = UTC_TIMESTAMP(), \`dispatch_state\` = 'waiting'
        WHERE \`do_id\` = :doId
          AND \`dp_id\` IS NULL
          AND \`status\` = 'offered'
          AND (\`dispatch_state\` IS NULL OR \`dispatch_state\` <> 'searching')`,
      { replacements: { doId: job.do_id }, type: QueryTypes.UPDATE }
    );

    if (Number(changed ?? 0) === 0) return null;

    const { logDispatch } = require("./dispatch/offers");
    await logDispatch(job.do_id, "ready_to_ship", {
      detail: "vendor marked the order ready; dispatching immediately",
    }).catch(() => {});

    return job.do_id;
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch ~ dispatchNowForSourceOrder ~", err.message);
    return null;
  }
}

// Best-effort wrapper for the order pipeline. Never throws.
async function queueDeliveryJob(orderId) {
  try {
    const job = await createJobForOrder(orderId);
    await parkUntilAccepted(job);
    return job;
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch ~ queueDeliveryJob ~ err:", err.message);
    return null;
  }
}

module.exports = {
  createJobForOrder,
  queueDeliveryJob,
  scheduleForSourceOrder,
  dispatchNowForSourceOrder,
  notifyAssignedRiderReady,
  computeEarnings,
};
