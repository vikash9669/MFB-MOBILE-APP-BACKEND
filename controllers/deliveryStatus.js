const { Op, fn, col } = require("sequelize");
const {
  DeliveryPartner,
  DeliveryOrder,
  DeliveryShift,
} = require("../models");
const { num, serializePartner } = require("../util/delivery");
const {
  startSession,
  closeSession,
  recordPoint,
} = require("../util/deliverySessions");
const { dispatchReady } = require("../util/dispatch/columns");
const { reassign } = require("../util/dispatch/engine");
const orderCustomerNotify = require("../util/orderCustomerNotify");

/**
 * Returns any not-yet-collected job held by a rider who just went offline.
 *
 * Deliberately limited to 'accepted': a job already picked up is physically
 * with that rider, and re-offering it would send a second rider to collect
 * food that has left the restaurant.
 */
async function releaseJobsOnGoingOffline(dpId) {
  if (!(await dispatchReady())) return;
  const held = await DeliveryOrder.findAll({
    where: { dp_id: dpId, status: "accepted" },
    attributes: ["do_id"],
    raw: true,
  });
  for (const job of held) {
    await reassign(job.do_id, "rider went offline before pickup");
  }
  if (held.length > 0) {
    console.log(`MFB ~ dispatch ~ rider ${dpId} went offline, released ${held.length} job(s)`);
  }
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Aggregates today's delivered-order stats for a partner.
const todayStats = async (dpId) => {
  const rows = await DeliveryOrder.findAll({
    where: {
      dp_id: dpId,
      status: "delivered",
      delivered_at: { [Op.gte]: startOfToday() },
    },
    attributes: [
      [fn("COUNT", col("do_id")), "orders"],
      [fn("COALESCE", fn("SUM", col("earn_total")), 0), "earnings"],
      [fn("COALESCE", fn("SUM", col("distance_km")), 0), "distance"],
    ],
    raw: true,
  });
  const r = rows[0] || {};
  return {
    orders: num(r.orders),
    earnings: num(r.earnings),
    distance: num(r.distance),
  };
};

// GET /delivery/home/summary — everything the Home screen needs in one call.
exports.getSummary = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }

    const stats = await todayStats(partner.dp_id);

    // Online pay accrued today (credited after midnight). Today's earnings are
    // deliveries plus this — the rider is paid for both.
    const { accruedToday } = require("../util/presence/onlinePay");
    const onlinePay = await accruedToday(partner.dp_id).catch(() => null);
    stats.delivery_earnings = stats.earnings;
    stats.online_pay = onlinePay ? onlinePay.amount : 0;
    stats.online_min = onlinePay ? onlinePay.online_min : 0;
    stats.earnings = Math.round((stats.delivery_earnings + stats.online_pay) * 100) / 100;

    // The shift running right now, if any, for the "You're online" banner —
    // judged by the clock and measured online time, not a stored status that
    // nothing used to update.
    const { liveFor } = require("./deliveryShifts");
    const { istDateOf } = require("../util/presence/config");
    const todaysShifts = await DeliveryShift.findAll({
      where: { dp_id: partner.dp_id, shift_date: istDateOf(Date.now()) },
    });
    const liveShifts = await liveFor(todaysShifts);
    const activeShift = todaysShifts.find((s) => liveShifts.get(s.shift_id)?.status === "active") ?? null;

    // Is there a job currently in progress (accepted / picked up)?
    const activeOrder = await DeliveryOrder.findOne({
      where: { dp_id: partner.dp_id, status: { [Op.in]: ["accepted", "picked_up"] } },
      order: [["accepted_at", "DESC"]],
    });

    // Simple incentive model: 13 orders unlocks a ₹150 bonus.
    const target = 13;
    const bonus = 150;

    res.json({
      partner: serializePartner(partner),
      online: !!partner.dp_online,
      today: stats,
      score: num(partner.dp_rating),
      incentive: {
        orders_done: stats.orders,
        orders_target: target,
        bonus_amount: bonus,
        progress: Math.min(1, target ? stats.orders / target : 0),
      },
      shift: activeShift
        ? {
            id: activeShift.shift_id,
            start_time: activeShift.start_time,
            end_time: activeShift.end_time,
            worked_min: liveShifts.get(activeShift.shift_id)?.worked_min ?? num(activeShift.worked_min),
            offline_min: liveShifts.get(activeShift.shift_id)?.offline_min ?? 0,
            label: activeShift.label,
          }
        : null,
      active_order_id: activeOrder ? activeOrder.do_id : null,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getSummary ~ err:", err);
    res.status(500).json({ message: "Failed to load home summary" });
  }
};

// POST /delivery/status/online — go online / offline.
exports.setOnline = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    const online = req.body.online === true || req.body.online === "true";
    const was = !!partner.dp_online;

    // Where the device was at the moment of the toggle. Optional: the app sends
    // it when location is granted and a fix arrives in time, and the toggle must
    // still work when it does not.
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const coords =
      Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

    // Keep the partner's last-known position current too, so the live map and
    // the session record agree.
    await partner.update(
      coords ? { dp_online: online, dp_lat: coords.lat, dp_lng: coords.lng } : { dp_online: online }
    );

    // Going offline with a job still in hand strands it: the customer waits on
    // a rider who has closed the app. Hand it straight back to the engine.
    // Only a job not yet picked up can be reassigned — once the food is on the
    // bike, reassignment is a human problem, not a routing one.
    if (was && !online) {
      await releaseJobsOnGoingOffline(partner.dp_id).catch((e) =>
        console.log("MFB ~ dispatch ~ release on offline ~", e.message)
      );
    }

    // Record the online→offline stretch. This is what active time is measured
    // from — dp_online alone keeps no history. Only act on an actual change, so
    // a repeated "go online" does not start a second session. Best-effort: the
    // toggle itself must never fail because bookkeeping did.
    if (was !== online) {
      try {
        if (online) await startSession(partner.dp_id, new Date(), coords);
        else await closeSession(partner.dp_id, new Date(), coords);
      } catch (sessErr) {
        console.log("MFB-error-logs ~ session bookkeeping ~ err:", sessErr);
      }
    }

    res.json({ message: online ? "You're online" : "You're offline", online });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery setOnline ~ err:", err);
    res.status(500).json({ message: "Failed to update status" });
  }
};

// POST /delivery/status/location — push the partner's live GPS position.
exports.updateLocation = async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ message: "lat and lng are required" });
    }
    await DeliveryPartner.update(
      { dp_lat: lat, dp_lng: lng },
      { where: { dp_id: req.user.dp_id } }
    );

    // Append the sample to the running online session, so a shift carries the
    // trail of where the partner actually was. Best-effort: losing a breadcrumb
    // must never fail the live-position push the map depends on.
    try {
      await recordPoint(req.user.dp_id, Number(lat), Number(lng));
    } catch (pointErr) {
      console.log("MFB-error-logs ~ session point ~ err:", pointErr);
    }

    // "Be ready, your rider is about to reach you."
    //
    // This is the only one of the six customer notifications with no event to
    // hang off — nothing happens when a rider gets close, so the location fix
    // the app already sends once a minute is the signal. Fire-and-forget and
    // internally guarded: the live tracking map depends on this endpoint, and a
    // proximity check must never take the rider's position down with it.
    orderCustomerNotify.checkNearDrop(req.user.dp_id, lat, lng).catch(() => {});

    res.json({ message: "Location updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery updateLocation ~ err:", err);
    res.status(500).json({ message: "Failed to update location" });
  }
};
