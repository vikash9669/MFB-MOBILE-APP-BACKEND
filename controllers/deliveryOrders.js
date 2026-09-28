const { Op, literal } = require("sequelize");
const {
  DeliveryOrder,
  DeliveryOrderEvent,
  DeliveryPartner,
} = require("../models");
const {
  num,
  serializeOrder,
  recordWalletTxn,
  logOrderEvent,
} = require("../util/delivery");
const { haversineKm, directions } = require("../util/geo");
const { notifyPartner } = require("../util/deliveryNotify");
const orderCustomerNotify = require("../util/orderCustomerNotify");
const riderNotify = require("../util/riderNotify");
const { QueryTypes } = require("sequelize");
const sequelize = require("../util/database");
const { dispatchReady } = require("../util/dispatch/columns");
const { startCollection, checkCollection } = require("../util/codCollection");
const { sendDeliveryOtp } = require("../util/customerAlerts");
const { isDevCode } = require("../util/otp");
const { syncFromDelivery } = require("../util/orderStatusSync");
const { notifyAdminsRiderCancelled } = require("../util/adminNotify");
const {
  acceptOffer,
  rejectOffer,
  liveOfferForRider,
  deadlineFor,
} = require("../util/dispatch/offers");

// Same simple incentive model the Home summary uses (13 orders → ₹150 bonus).
const BONUS_TARGET = 13;
const BONUS_AMOUNT = 150;

// How far a rider will be sent to a pickup. Beyond this the job is left in the
// pool for someone closer.
const maxOfferKm = () => num(process.env.DELIVERY_MAX_OFFER_KM, 8);

// How many of the oldest open offers to consider before ranking by distance.
const OFFER_POOL_SIZE = 20;

const ACTIVE_STATES = ["accepted", "picked_up"];

// Finds the partner's single in-progress job, if any.
const findActive = (dpId) =>
  DeliveryOrder.findOne({
    where: { dp_id: dpId, status: { [Op.in]: ACTIVE_STATES } },
    order: [["accepted_at", "DESC"]],
  });

// GET /delivery/orders/incoming — the next unassigned job to offer this rider.
// Returns { order: null } plus a reason when there's nothing to offer, so the
// app can show the "looking for orders" state.
//
// Picks the nearest open pickup within DELIVERY_MAX_OFFER_KM of where the rider
// last reported being, falling back to oldest-first when we don't know where
// either the rider or the restaurant is. Jobs the rider has already passed on
// are excluded — previously they came straight back on the next poll.
exports.getIncoming = async (req, res) => {
  try {
    const dpId = req.user.dp_id;

    const partner = await DeliveryPartner.findByPk(dpId);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    // An offline rider isn't accepting work; don't hand them a job.
    if (!partner.dp_online) {
      return res.json({ order: null, reason: "offline" });
    }

    // Don't offer a new job while one is already in progress.
    const active = await findActive(dpId);
    if (active) {
      return res.json({ order: null, reason: "busy" });
    }

    // ── Targeted dispatch ────────────────────────────────────────────────
    // When the engine is live, a rider is not shown the pool at all: they see
    // the one job the engine has offered *them*, for as long as that offer
    // lasts. The response shape is unchanged, so the partner app needs no
    // update — it keeps polling this endpoint and simply gets a better answer.
    if (await dispatchReady()) {
      const offer = await liveOfferForRider(dpId);
      if (offer == null) return res.json({ order: null, reason: "searching" });

      const job = await DeliveryOrder.findByPk(offer.do_id);
      // The job moved on between the offer lookup and now.
      if (job == null || job.status !== "offered" || job.dp_id != null) {
        return res.json({ order: null, reason: "searching" });
      }

      // Per-rider, so it is filled in here rather than stored on the row.
      if (offer.distance_km != null) job.pickup_distance_km = num(offer.distance_km);

      return res.json({
        order: serializeOrder(job),
        // Lets the app show a countdown instead of a silent disappearance.
        //
        // Rebuilt on THIS process's clock from the remaining seconds, never
        // passed through from the database — see deadlineFor(). The raw column
        // is in the database's clock, which on production runs 5h30m behind
        // real UTC, and a phone comparing that against its own Date.now() threw
        // every offer away as expired before the rider could see it.
        expires_at: deadlineFor(offer),
      });
    }

    // ── Open pool (pre-migration fallback) ───────────────────────────────
    // Anything this rider already rejected stays rejected for them.
    const passed = await DeliveryOrderEvent.findAll({
      where: { dp_id: dpId, status: "rejected" },
      attributes: ["do_id"],
      raw: true,
    });
    const passedIds = passed.map((p) => p.do_id);

    const where = { status: "offered", dp_id: null };
    if (passedIds.length > 0) {
      where.do_id = { [Op.notIn]: passedIds };
    }

    // Never offer a job whose order has been cancelled.
    //
    // util/orderLifecycle.js retracts the job when it cancels an order, so in
    // the normal path this changes nothing. It exists because that is not the
    // only path: the legacy PHP admin panel writes store_orders.order_status
    // directly and never calls cancelOrder, and so does anyone editing the
    // database by hand. Filtering on the job's own status alone therefore left
    // cancelled orders sitting in the pool indefinitely, claimable by a rider
    // who would ride to a restaurant for an order that no longer exists.
    //
    // A correlated NOT EXISTS rather than NOT IN: there are tens of thousands of
    // cancelled orders, and this way each candidate costs one primary-key
    // lookup instead of materialising that whole set.
    where[Op.and] = [
      literal(
        "NOT EXISTS (SELECT 1 FROM `store_orders` `o` " +
          "WHERE `o`.`order_id` = `delivery_order`.`source_order_id` " +
          "AND `o`.`order_status` = 6)"
      ),
    ];

    const rider =
      partner.dp_lat != null && partner.dp_lng != null
        ? { lat: num(partner.dp_lat), lng: num(partner.dp_lng) }
        : null;

    // Narrow to jobs near this rider BEFORE the row limit.
    //
    // This used to take the oldest 20 open jobs and only then filter by
    // distance, which starves the pool: once 20 stale jobs nobody will take sit
    // at the front of the queue, every newer job is invisible to every rider,
    // permanently. Observed live with 23 open jobs — a job 1.1km from an online
    // rider was never shown because it sorted 23rd by age.
    //
    // A bounding box on the pickup columns keeps the limit meaningful. The
    // circle is still cut precisely in JS below; this only shrinks the candidate
    // set to something the limit can honestly represent.
    if (rider != null) {
      const kmPerDegLat = 111;
      const kmPerDegLng =
        kmPerDegLat * Math.cos((rider.lat * Math.PI) / 180) || kmPerDegLat;
      const dLat = maxOfferKm() / kmPerDegLat;
      const dLng = maxOfferKm() / kmPerDegLng;
      where[Op.or] = [
        // Jobs we could not geocode stay eligible rather than being stranded.
        { pickup_lat: null },
        {
          pickup_lat: { [Op.between]: [rider.lat - dLat, rider.lat + dLat] },
          pickup_lng: { [Op.between]: [rider.lng - dLng, rider.lng + dLng] },
        },
      ];
    }

    const offers = await DeliveryOrder.findAll({
      where,
      order: [["offered_at", "ASC"]],
      limit: OFFER_POOL_SIZE,
    });
    if (offers.length === 0) {
      return res.json({ order: null });
    }

    // Without a rider fix we can't rank by distance, so keep the old
    // oldest-first behaviour rather than dropping jobs on the floor.
    if (rider == null) {
      return res.json({ order: serializeOrder(offers[0]) });
    }

    const ranked = offers
      .map((order) => ({
        order,
        km:
          order.pickup_lat != null && order.pickup_lng != null
            ? haversineKm(rider, {
                lat: num(order.pickup_lat),
                lng: num(order.pickup_lng),
              })
            : null,
      }))
      // A job we couldn't geocode stays eligible — it just sorts last, so it
      // isn't stranded in the pool forever.
      .filter((c) => c.km == null || c.km <= maxOfferKm())
      .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));

    if (ranked.length === 0) {
      return res.json({ order: null, reason: "none_nearby" });
    }

    const best = ranked[0];
    // How far this rider is from the restaurant is per-rider, so it's filled in
    // here rather than stored on the row. Not saved — display only.
    if (best.km != null) {
      best.order.pickup_distance_km = Math.round(best.km * 10) / 10;
    }

    res.json({ order: serializeOrder(best.order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getIncoming ~ err:", err);
    res.status(500).json({ message: "Failed to load incoming order" });
  }
};

// GET /delivery/orders/active — the job currently assigned + in progress.
exports.getActive = async (req, res) => {
  try {
    const active = await findActive(req.user.dp_id);
    res.json({ order: active ? serializeOrder(active) : null });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getActive ~ err:", err);
    res.status(500).json({ message: "Failed to load active order" });
  }
};

// GET /delivery/orders/:id — a single order (any state) owned by the partner.
exports.getOne = async (req, res) => {
  try {
    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }

    // A partner may read their own job, or one still sitting unclaimed in the
    // pool. Without this any authenticated rider could walk the id range and
    // read every customer's name, phone and address. 404 rather than 403 so the
    // response doesn't confirm the order exists.
    const isMine = order.dp_id === req.user.dp_id;
    const isOpenOffer = order.dp_id == null && order.status === "offered";
    if (!isMine && !isOpenOffer) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json({ order: serializeOrder(order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getOne ~ err:", err);
    res.status(500).json({ message: "Failed to load order" });
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

    // The claim MUST be a conditional UPDATE, not a check followed by a write.
    //
    // This was previously:
    //     if (order.status !== "offered" || order.dp_id != null) return 409;
    //     await order.update({ dp_id: dpId, ... });
    //
    // Two riders polling the same open job can both pass that check before
    // either writes, and both end up "assigned" — two riders at one counter
    // for one bag. The window is milliseconds and it will be hit, because the
    // app polls on a timer and every rider's timer fires at the same moments.
    //
    // With the engine live, acceptOffer settles the offer and the job together;
    // without it, the same guarantee comes from the WHERE clause below.
    if (await dispatchReady()) {
      const claim = await acceptOffer(order.do_id, dpId);
      if (!claim.ok) return res.status(409).json({ message: claim.reason });
    } else {
      const [, claimed] = await sequelize.query(
        `UPDATE \`store_delivery_orders\`
            SET \`dp_id\` = :dpId, \`status\` = 'accepted', \`accepted_at\` = UTC_TIMESTAMP()
          WHERE \`do_id\` = :doId AND \`status\` = 'offered' AND \`dp_id\` IS NULL`,
        { replacements: { doId: order.do_id, dpId }, type: QueryTypes.UPDATE }
      );
      if (Number(claimed ?? 0) === 0) {
        return res.status(409).json({ message: "Order is no longer available" });
      }
    }

    // Re-read so the response carries what was actually committed.
    await order.reload();
    await logOrderEvent(order.do_id, dpId, "accepted", "Partner accepted the order");

    await notifyPartner(dpId, {
      category: "orders",
      icon: "receipt_long",
      title: `Order #${order.order_ref} assigned`,
      body: `Pick up from ${order.pickup_name} · ${order.pickup_area || ""}`.trim(),
      data: { type: "order_assigned", do_id: order.do_id },
    });

    // The customer's half of the same moment. Until now only the rider heard
    // anything from accept onwards, so the person waiting for the food learned
    // nothing between "being prepared" and it turning up at the door.
    orderCustomerNotify
      .riderAssigned(order.source_order_id, req.user?.dp_name)
      .catch(() => {});

    // Text the customer their door code. It is shown in the app too, but the
    // app is exactly what a customer may not have open when the rider arrives —
    // and without the code the food cannot be handed over. Fire-and-forget:
    // an accepted job must not fail because a message did.
    sendDeliveryOtp({
      // The address's own number when there is one: that is the number for
      // this delivery, not necessarily the account's.
      phone: order.drop_phone,
      orderId: order.order_ref || order.source_order_id || order.do_id,
      otp: order.drop_otp,
      // Name is a nicety, not worth a query on the accept path — the message
      // reads fine as "Your delivery partner is on the way" without it.
      riderName: req.user?.dp_name,
    })
      .then((r) => {
        // Every non-send is now a real problem worth logging — the dry-run case
        // that used to be excluded here no longer exists.
        if (!r.sent) {
          console.log(`MFB ~ delivery otp sms ~ #${order.do_id} not sent: ${r.reason}`);
        }
      })
      .catch((e) => console.log("MFB ~ delivery otp sms ~", e.message));

    res.json({ message: "Order accepted", order: serializeOrder(order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery accept ~ err:", err);
    res.status(500).json({ message: "Failed to accept order" });
  }
};

// POST /delivery/orders/:id/reject — decline an offered job. The recorded event
// is what keeps getIncoming from handing the same job straight back.
// GET /delivery/orders/:id/route?leg=pickup|drop[&lat=&lng=]
//
// The road route for one leg of one job. The partner app drew a dotted straight
// line between two pins — through buildings, across the river — because nothing
// ever computed a real route; only a padded straight-line distance existed.
//
// Deliberately scoped to a job the caller owns (or has been offered) and to its
// own endpoints: the alternative, a general "route from A to B" endpoint, is an
// open proxy that bills our Directions quota for anyone with a rider token.
exports.getRoute = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    // Either it is theirs, or it is still unclaimed and they are being offered it.
    if (order.dp_id != null && order.dp_id !== dpId) {
      return res.status(403).json({ message: "Not your order" });
    }

    const leg = req.query.leg === "drop" ? "drop" : "pickup";
    const to =
      leg === "drop"
        ? { lat: num(order.drop_lat), lng: num(order.drop_lng) }
        : { lat: num(order.pickup_lat), lng: num(order.pickup_lng) };

    // Prefer a live fix from the app; fall back to the rider's last known spot.
    const qLat = Number(req.query.lat);
    const qLng = Number(req.query.lng);
    let from = Number.isFinite(qLat) && Number.isFinite(qLng) ? { lat: qLat, lng: qLng } : null;
    if (from == null) {
      const partner = await DeliveryPartner.findByPk(dpId, { raw: true });
      if (partner?.dp_lat != null) {
        from = { lat: num(partner.dp_lat), lng: num(partner.dp_lng) };
      }
    }
    // Heading to the customer, the leg starts at the restaurant.
    if (from == null && leg === "drop") {
      from = { lat: num(order.pickup_lat), lng: num(order.pickup_lng) };
    }

    if (from == null || !Number.isFinite(to.lat) || !Number.isFinite(to.lng)) {
      return res.json({ route: null, reason: "missing coordinates" });
    }

    const route = await directions(from, to);
    // null is a normal answer — the app keeps its straight line rather than
    // showing an empty map.
    res.json({ route, from, to });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getRoute ~ err:", err);
    res.status(500).json({ message: "Failed to load route" });
  }
};

exports.reject = async (req, res) => {
  try {
    const dpId = req.user.dp_id;

    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null) {
      return res.status(404).json({ message: "Order not found" });
    }
    // Only an unclaimed offer can be passed on; rejecting someone else's job
    // would otherwise write a misleading entry onto their timeline.
    if (order.dp_id != null || order.status !== "offered") {
      return res.status(409).json({ message: "Order is no longer available" });
    }

    // Closing the offer frees the job on the very next engine tick rather than
    // leaving it to time out — a decline is information, and waiting out the
    // full TTL after one would waste most of the acceptance window.
    if (await dispatchReady()) {
      await rejectOffer(order.do_id, dpId, req.body?.reason);
    }

    // Polling can fire this twice for one tap — one pass per rider is enough.
    const already = await DeliveryOrderEvent.findOne({
      where: { do_id: order.do_id, dp_id: dpId, status: "rejected" },
    });
    if (already == null) {
      await logOrderEvent(order.do_id, dpId, "rejected", "Partner rejected the offer");
    }
    res.json({ message: "Order rejected" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery reject ~ err:", err);
    res.status(500).json({ message: "Failed to reject order" });
  }
};

// POST /delivery/orders/:id/verify-pickup — confirm pickup with the store OTP.
// POST /delivery/orders/:id/collect
// Rider offers "pay online instead" at the door. Returns the URL to render as
// a QR. Idempotent: re-opening the screen resumes the same payment.
exports.startCollect = async (req, res) => {
  try {
    const result = await startCollection({
      doId: Number(req.params.id),
      dpId: req.user.dp_id,
    });

    if (!result.ok) {
      if (result.reason === "not_migrated") {
        return res.status(503).json({
          message:
            "Online collection is not enabled yet. Run migrations/2026-08-12-cod-online-collection.sql.",
        });
      }
      return res.status(409).json({ message: result.reason });
    }

    res.json({
      already_paid: Boolean(result.alreadyPaid),
      reused: Boolean(result.reused),
      merchant_txn_id: result.merchantTxnId ?? null,
      amount: result.amount,
      // The rider's app renders this as a QR; the customer's camera opens it.
      collect_url: result.collectUrl ?? null,
      // True when it is a real upi:// payment code — the customer's UPI app
      // opens straight on a confirm screen with the amount filled in. False
      // means we could only issue a hosted-checkout link, which sends them
      // through a web page first. The screen words itself differently for each,
      // because "scan to pay" is a promise the second one doesn't keep.
      is_upi_qr: Boolean(result.isUpiQr),
      expires_at: result.expiresAt ?? null,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery startCollect ~ err:", err);
    res.status(500).json({ message: "Could not start online collection" });
  }
};

// GET /delivery/orders/:id/collect
// Where the collection stands. The app polls this; it never decides for itself
// whether money arrived — only the gateway's status API can say that.
exports.collectStatus = async (req, res) => {
  try {
    const order = await DeliveryOrder.findByPk(req.params.id, { attributes: ["do_id", "dp_id"] });
    if (order == null || order.dp_id !== req.user.dp_id) {
      return res.status(404).json({ message: "Order not found" });
    }
    const state = await checkCollection({
      doId: Number(req.params.id),
      dpId: req.user.dp_id,
    });
    res.json(state);
  } catch (err) {
    console.log("MFB-error-logs ~ delivery collectStatus ~ err:", err);
    res.status(500).json({ message: "Could not check payment" });
  }
};

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

    // Pickup is a confirmation, not a code check.
    //
    // pickup_otp was generated on every job and demanded here, but it was never
    // shown to anybody — not in the vendor panel, not in the vendor email, not
    // in any API a restaurant can reach. The restaurant could not have known the
    // code, so no delivery could ever get past this line. It is also not how
    // food delivery works: the big platforms verify pickup by order id and keep
    // the OTP for the customer's door, where it actually proves something.
    //
    // A code is still honoured when one is sent, so an older app build keeps
    // working; it is simply no longer required.
    if (
      otp != null &&
      String(otp) !== "" &&
      String(otp) !== String(order.pickup_otp) &&
      !isDevCode(otp)
    ) {
      return res.status(401).json({ message: "Incorrect pickup code" });
    }

    if (req.body.photo) {
      await order.update({ proof_photo: req.body.photo });
    }
    await order.update({ status: "picked_up", picked_up_at: new Date() });

    // Mirror onto the legacy order so the panel stops saying "Ready to Ship"
    // while the food is already on a bike. Best-effort and never awaited into
    // the failure path: the pickup is confirmed, and the panel catching up is
    // not worth failing a rider standing at a counter.
    await syncFromDelivery(order.source_order_id, "picked_up", { dpId });
    await logOrderEvent(order.do_id, dpId, "picked_up", "Order picked up from store");

    await notifyPartner(dpId, {
      category: "orders",
      icon: "two_wheeler",
      title: `Picked up · Order #${order.order_ref}`,
      body: `Deliver to ${order.drop_name} · ${order.drop_area || ""}`.trim(),
      data: { type: "order_picked_up", do_id: order.do_id },
    });

    orderCustomerNotify
      .orderPickedUp(order.source_order_id, req.user?.dp_name)
      .catch(() => {});

    res.json({ message: "Pickup confirmed", order: serializeOrder(order) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery verifyPickup ~ err:", err);
    res.status(500).json({ message: "Failed to confirm pickup" });
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
    // isDevCode is inert unless OTP_DEV_MODE is on. It exists because the drop
    // code reaches the customer by SMS only — with the provider unavailable,
    // nobody can produce it and no delivery can ever be completed.
    if (String(otp) !== String(order.drop_otp) && !isDevCode(otp)) {
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
    await syncFromDelivery(order.source_order_id, "delivered", { dpId });

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
    //
    // Sent from riderNotify so it can say what happened to the MONEY as well
    // as the earning: on a COD job the cash the rider is now carrying is owed
    // back and gates whether they get offered more work, which a bare
    // "Earned ₹X" never mentioned.
    await riderNotify.orderDelivered(order.do_id);

    // The customer's side: the meal is here, and this is the one moment a
    // request to rate the rider is actually welcome. Deep-links straight to
    // the rating card rather than the top of the tracking screen.
    orderCustomerNotify
      .orderDelivered(order.source_order_id, req.user?.dp_name)
      .catch(() => {});

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
    res.status(500).json({ message: "Failed to confirm delivery" });
  }
};

// POST /delivery/orders/:id/report-issue — the rider flags a problem with the
// active job (customer unreachable, wrong address, …). Logs it to the order
// timeline and raises a notification; support follows up out of band.

// ── Rider hand-back helpers ────────────────────────────────────────────

// The placeholder store_orders.rider_id carries when nobody is assigned — the
// value util/orders.js writes at placement and controllers/admin/notify.js
// tests against. Same constant, spelled out here rather than imported, because
// importing the notify controller from here would close a require cycle.
const UNASSIGNED_RIDER_ID = 1;

/**
 * Undoes the panel's half of an assignment when the rider walks away.
 *
 * store_orders.rider_id is what the admin Orders list and its emails read. It
 * is set when an admin assigns from the panel, and a delivery partner is the
 * same store_users row as the panel rider (dp_id maps to user_id — see
 * models/delivery_partner.js), so the two ids compare directly.
 *
 * Only clears a rider_id that names THIS rider: an admin may have assigned
 * somebody else since, and overwriting that would silently undo their decision.
 *
 * "Cleared" means back to the placeholder 1, NOT NULL. store_orders.rider_id is
 * NOT NULL DEFAULT 1 and 1 is what util/orders.js writes at placement, which is
 * how controllers/admin/notify.js recognises an unassigned order. Writing NULL
 * looks right and is not: MySQL coerces it to 0 on this column, and 0 is not
 * the placeholder, so the order would read as assigned to a user that does not
 * exist — no rider mail, no rider on the panel, and nothing to explain it.
 *
 * Also walks the order back from "On the Way" to "Ready to Ship" when the food
 * had been collected, because nothing is on the way any more. That is the one
 * place in the codebase that moves an order backwards, and it is deliberate:
 * orderStatusSync only ever moves forward, so without this the panel would go
 * on showing a delivery in progress that nobody is performing.
 */
async function releasePanelAssignment(sourceOrderId, dpId, afterPickup) {
  if (!sourceOrderId) return { cleared: 0 };

  const [, cleared] = await sequelize.query(
    `UPDATE \`store_orders\` SET \`rider_id\` = :unassigned
      WHERE \`order_id\` = :orderId AND \`rider_id\` = :dpId`,
    {
      replacements: { orderId: sourceOrderId, dpId, unassigned: UNASSIGNED_RIDER_ID },
      type: QueryTypes.UPDATE,
    }
  );

  if (afterPickup) {
    await sequelize.query(
      `UPDATE \`store_orders\` SET \`order_status\` = :readyToShip
        WHERE \`order_id\` = :orderId AND \`order_status\` = :onTheWay`,
      {
        replacements: { orderId: sourceOrderId, readyToShip: 3, onTheWay: 4 },
        type: QueryTypes.UPDATE,
      }
    );
  }

  return { cleared: Number(cleared ?? 0) };
}

/**
 * Where a handed-back job goes next.
 *
 * Before pickup the restaurant still holds the food, so the engine can simply
 * offer it to somebody else ('searching'). After pickup it cannot: the bag is
 * with the rider who just walked away, and sending a second rider to the
 * counter wastes their trip. Those park at 'failed', which is exactly what the
 * panel's unassigned list selects on — see controllers/admin/dispatch.js.
 */
const dispatchStateAfterCancel = (afterPickup) => (afterPickup ? "failed" : "searching");

/**
 * Cancellations as a percentage of the jobs a rider committed to.
 *
 * One decimal place, and 0 when they have no history at all — a first-ever job
 * handed back should not read as "100% cancellation rate" on the performance
 * screen, which is what dividing by their one job would say.
 */
const cancellationPct = (cancelled, delivered) => {
  const committed = Number(cancelled || 0) + Number(delivered || 0);
  if (committed === 0) return 0;
  return Math.round((Number(cancelled || 0) / committed) * 1000) / 10;
};

/**
 * Recomputes the rider's cancellation rate from their own history.
 *
 * Derived rather than incremented: a counter needs every writer to agree and
 * nothing else in this codebase maintains these columns yet (they are display
 * fields, seeded by util/deliveryDemo.js). Counting the rows each time cannot
 * drift, and at a rider's lifetime volume it is two indexed counts.
 *
 * The denominator is "jobs this rider committed to" — the ones they saw through
 * plus the ones they handed back. Offers they never accepted belong to the
 * acceptance rate, which is a different number about a different decision.
 */
async function recordCancellation(dpId) {
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM \`store_delivery_order_events\`
         WHERE \`dp_id\` = :dpId AND \`status\` = 'cancelled_by_rider') AS cancelled,
       (SELECT COUNT(*) FROM \`store_delivery_orders\`
         WHERE \`dp_id\` = :dpId AND \`status\` = 'delivered') AS delivered`,
    { replacements: { dpId }, type: QueryTypes.SELECT }
  );

  const pct = cancellationPct(row?.cancelled, row?.delivered);
  if (pct === 0 && !Number(row?.cancelled || 0)) return { pct: 0 };

  await DeliveryPartner.update({ dp_cancellation_pct: pct }, { where: { dp_id: dpId } });
  return { pct };
}

// POST /delivery/orders/:id/cancel — a rider hands a job back.
//
// Distinct from reject, which declines an offer nobody has taken yet and costs
// the customer nothing. This one fires after the rider committed: somebody is
// waiting for food that, as of this call, has nobody bringing it. So the job
// goes back to the pool, an admin is told immediately, and the customer hears
// that a new rider is being found.
//
// WHAT HAPPENS TO THE JOB depends on whether the food had been collected:
//
//   before pickup   dispatch_state 'searching' — the restaurant still holds the
//                   order, so the engine simply offers it to somebody else and
//                   the customer may never notice.
//   after pickup    dispatch_state 'failed' — the food is in the bag of the
//                   rider who just stopped delivering it. Offering that job to
//                   another rider sends them to a counter with nothing on it,
//                   so it parks in the panel's unassigned list where a person
//                   decides: recover the bag, or have the kitchen remake it.
//
// The rider's own claim is released either way — leaving dp_id set would keep
// the job on their active screen and block them from taking anything else.
exports.cancelDelivery = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const reason = String(req.body?.reason || "").trim();
    const note = String(req.body?.note || "").trim();
    const photo = req.body?.photo || null;

    if (!reason) {
      return res.status(400).json({ message: "Pick a reason for cancelling" });
    }

    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null || order.dp_id !== dpId) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Only a job this rider is actually carrying can be handed back. An offer
    // they have not accepted is a reject; a delivered one is history.
    if (!["accepted", "picked_up"].includes(order.status)) {
      return res.status(409).json({
        message:
          order.status === "delivered"
            ? "This order has already been delivered."
            : "This order is no longer yours to cancel.",
      });
    }

    const afterPickup = order.status === "picked_up";

    // The claim is released with a conditional UPDATE for the same reason
    // accept takes one: the engine may be mid-tick on this very job, and a
    // check-then-write would let both hands move it.
    const [, released] = await sequelize.query(
      `UPDATE \`store_delivery_orders\`
          SET \`status\` = 'offered', \`dp_id\` = NULL, \`accepted_at\` = NULL,
              \`picked_up_at\` = NULL,
              \`dispatch_state\` = :dispatchState, \`dispatch_at\` = UTC_TIMESTAMP(),
              \`dispatch_note\` = :note,
              \`cancel_reason\` = :reason, \`cancel_note\` = :riderNote,
              \`cancel_photo\` = :photo, \`cancelled_by_dp_id\` = :dpId,
              \`cancelled_at\` = UTC_TIMESTAMP(),
              \`cancelled_after_pickup\` = :afterPickup
        WHERE \`do_id\` = :doId AND \`dp_id\` = :dpId
          AND \`status\` IN ('accepted', 'picked_up')`,
      {
        replacements: {
          doId: order.do_id,
          dpId,
          dispatchState: dispatchStateAfterCancel(afterPickup),
          note: `rider cancelled: ${reason}`.slice(0, 255),
          reason: reason.slice(0, 80),
          riderNote: note ? note.slice(0, 255) : null,
          photo: photo || null,
          afterPickup: afterPickup ? 1 : 0,
        },
        type: QueryTypes.UPDATE,
      }
    );

    if (Number(released ?? 0) === 0) {
      // Something else moved the job between the read and the write — most
      // likely the rider tapping twice, or an admin reassigning it.
      return res.status(409).json({ message: "This order is no longer yours to cancel." });
    }

    // Withdraw any offer rows still pointing at this rider, so the engine does
    // not count a settled offer as live and skip the next round.
    if (await dispatchReady()) {
      await sequelize
        .query(
          `UPDATE \`store_delivery_offers\` SET \`state\` = 'withdrawn'
            WHERE \`do_id\` = :doId AND \`state\` = 'pending'`,
          { replacements: { doId: order.do_id }, type: QueryTypes.UPDATE }
        )
        .catch((e) => console.log("MFB ~ cancelDelivery ~ withdraw offers ~", e.message));
    }

    await logOrderEvent(
      order.do_id,
      dpId,
      "cancelled_by_rider",
      `${reason}${note ? ` — ${note}` : ""}${afterPickup ? " (after pickup)" : ""}`.slice(0, 255)
    );

    // The panel's own copy of the assignment. store_orders.rider_id is set when
    // an admin assigns from the panel, and it is what the Orders list shows —
    // left alone it would name a rider who has just walked away. The order also
    // goes back from "On the Way" to "Ready to Ship" when the job had been
    // picked up, because nothing is on the way any more.
    await releasePanelAssignment(order.source_order_id, dpId, afterPickup).catch((e) =>
      console.log("MFB ~ cancelDelivery ~ panel release ~", e.message)
    );

    // Everything past here is a side effect: the hand-back is committed, and a
    // failed push or a dead SMTP host must not turn it into an error the rider
    // retries.
    notifyPartner(dpId, {
      category: "orders",
      icon: "cancel",
      title: `Cancelled · Order #${order.order_ref}`,
      body: "This delivery has been handed back. Our team has been notified.",
      data: { type: "order_cancelled_by_rider", do_id: order.do_id },
    }).catch(() => {});

    notifyAdminsRiderCancelled({
      orderId: order.source_order_id,
      doId: order.do_id,
      riderName: req.user?.dp_name,
      riderPhone: req.user?.dp_phone,
      reason,
      note,
      afterPickup,
      hasPhoto: Boolean(photo),
      requeued: !afterPickup,
    }).catch((e) => console.log("MFB ~ cancelDelivery ~ admin alert ~", e.message));

    orderCustomerNotify
      .riderDropped(order.source_order_id, { requeued: !afterPickup })
      .catch(() => {});

    // Count it against the rider. Deliberately after the alerts: a stats write
    // that fails must not cost the office its warning.
    recordCancellation(dpId).catch((e) =>
      console.log("MFB ~ cancelDelivery ~ stats ~", e.message)
    );

    res.json({
      message: afterPickup
        ? "Delivery cancelled. Our team will call you about the order you are holding."
        : "Delivery cancelled. The order has gone back to other partners.",
      requeued: !afterPickup,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery cancelDelivery ~ err:", err);
    res.status(500).json({ message: "Failed to cancel this delivery" });
  }
};

// Exported for tests: the two decisions in the hand-back worth pinning down
// without a database behind them.
exports._dispatchStateAfterCancel = dispatchStateAfterCancel;
exports._cancellationPct = cancellationPct;

exports.reportIssue = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const { reason } = req.body;

    const order = await DeliveryOrder.findByPk(req.params.id);
    if (order == null || order.dp_id !== dpId) {
      return res.status(404).json({ message: "Order not found" });
    }

    await logOrderEvent(order.do_id, dpId, "issue_reported", reason || "Issue reported");
    await notifyPartner(dpId, {
      category: "orders",
      icon: "report",
      title: `Issue reported · Order #${order.order_ref}`,
      body: reason ? `“${reason}” — our team will reach out shortly.` : "Our team will reach out shortly.",
      data: { type: "issue_reported", do_id: order.do_id },
    });

    res.json({ message: "Issue reported. Support will contact you shortly." });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery reportIssue ~ err:", err);
    res.status(500).json({ message: "Failed to report issue" });
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
    res.status(500).json({ message: "Failed to load history" });
  }
};
