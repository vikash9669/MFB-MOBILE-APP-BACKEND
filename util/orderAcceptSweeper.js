// Drives an unaccepted order through its acceptance window.
//
//   t=0                      order placed; vendor gets panel ring, WhatsApp, call, email
//   every REMINDER_EVERY_MIN vendor re-alerted (WhatsApp + call)
//   t=ESCALATE_MIN  (5 min)  admin told on WhatsApp + email that the vendor is silent
//   t=CANCEL_MIN   (10 min)  order cancelled, online payment refunded, customer told
//
// "Accepted" means order_status has moved off 0 (Received). Any onward status —
// Processed, Vendor, Ready to Ship — means somebody has acted on it.
//
// TWO THINGS SHAPE THIS DESIGN, both consequences of existing data:
//
// 1. Order timestamps cannot be trusted. store_orders.order_received_time is
//    written by util/orders.js as `Date.now() + 5.5h` (a manual IST shift),
//    while rows written by the old PHP panel carry a real timestamp. The same
//    column therefore means different things per row, and "older than N
//    minutes" is not answerable from it. So age is measured from when this
//    process first saw the order, held in memory.
//
// 2. There is a large historical backlog at status 0 — orders from months ago
//    that were never progressed. Cancelling those would refund payments from
//    last July, so the sweeper takes a high-water mark at boot and only ever
//    touches orders placed after it started.
//
// Both compromises fail in the safe direction, which matters much more now that
// the end of this ladder moves money: a restart forgets in-flight clocks, so an
// order gets a fresh 10 minutes rather than being cancelled early, and anything
// from before boot is left alone entirely rather than being cancelled late.
const { Op } = require("sequelize");
const { StoreOrders, User, Business } = require("../models");
const { alertVendorNewOrder } = require("./vendorAlerts");
const { cancelOrder } = require("./orderLifecycle");
const origins = require("./origins");

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Gap between vendor reminders.
const REMINDER_EVERY_MIN = num(process.env.ORDER_ACCEPT_REMINDER_EVERY_MIN, 2);
// When admin staff are pulled in.
const ESCALATE_MIN = num(process.env.ORDER_ACCEPT_ESCALATE_MIN, 5);
// The acceptance window. Past this the order is cancelled and refunded.
const CANCEL_MIN = num(process.env.ORDER_ACCEPT_CANCEL_MIN, 10);
// Belt and braces: if auto-cancel is switched off, stop tracking eventually.
const GIVE_UP_MIN = num(process.env.ORDER_ACCEPT_GIVE_UP_MIN, 60);
// Auto-cancel is the only step that moves money, so it has its own kill switch
// independent of the alert channels.
const AUTO_CANCEL = process.env.ORDER_AUTO_CANCEL !== "false";

const EVERY_MS = 30000;
const RECEIVED = 0;

// orderId -> { firstSeen, reminders, lastReminderAt, escalated, abandoned }
// `abandoned` means we are done with this order but it is still pending, so the
// entry must stay to stop it being picked up again as if it were new.
const tracked = new Map();

// Orders at or below this existed before we started; not our business.
let watermark = null;

const minutesSince = (t) => (Date.now() - t) / 60000;

/** Whether this order is due another nudge. */
const dueForReminder = (entry) => {
  const age = minutesSince(entry.firstSeen);
  // Stop nagging the vendor once the order is about to be cancelled — at that
  // point the message they need is "too late", not "please accept".
  if (AUTO_CANCEL && age >= CANCEL_MIN) return false;
  if (entry.lastReminderAt == null) return age >= REMINDER_EVERY_MIN;
  return minutesSince(entry.lastReminderAt) >= REMINDER_EVERY_MIN;
};

async function vendorOf(order) {
  const [vendorUser, business] = await Promise.all([
    order.vendor_id ? User.findByPk(order.vendor_id, { raw: true }) : null,
    order.vendor_id
      ? Business.findOne({ where: { user_id: order.vendor_id }, raw: true })
      : null,
  ]);
  return { vendorUser, business };
}

const orderTotal = (order) =>
  Number(order.order_amount || 0) +
  Number(order.delivery_charges || 0) -
  Number(order.order_discount || 0);

async function remind(order, entry) {
  const { vendorUser, business } = await vendorOf(order);
  await alertVendorNewOrder({
    orderId: order.order_id,
    vendorName: business?.business_name || vendorUser?.user_name,
    phone: vendorUser?.user_phone,
    itemCount: 0,
    total: orderTotal(order),
    acceptUrl:
      (process.env.PANEL_URL ? process.env.PANEL_URL.replace(/\/$/, "") : origins.webBase(null)) +
      "/vendor/portal/new-orders",
    reminder: entry.reminders + 1,
  });
  entry.reminders += 1;
  entry.lastReminderAt = Date.now();
}

async function escalate(order, age) {
  const { escalateUnaccepted } = require("../controllers/admin/notify");
  await escalateUnaccepted(order.order_id, Math.round(age), AUTO_CANCEL ? CANCEL_MIN : 0).catch(
    (err) => console.log("MFB-error-logs ~ accept sweeper ~ escalate ~", err.message)
  );
}

async function expire(order) {
  const result = await cancelOrder({
    orderId: order.order_id,
    reason: `Not accepted by the restaurant within ${CANCEL_MIN} minutes`,
    by: "system",
  });

  // Lost the race: a vendor or admin moved it while we were working.
  if (!result.ok) return result;

  const paidOnline = String(order.order_payment_type).toUpperCase() === "PG";
  const { notifyOrderAutoCancelled } = require("../controllers/admin/notify");
  await notifyOrderAutoCancelled(order.order_id, {
    refunded: paidOnline ? Boolean(result.refund?.accepted) : null,
    amount: orderTotal(order),
  }).catch((err) =>
    console.log("MFB-error-logs ~ accept sweeper ~ auto-cancel notify ~", err.message)
  );

  return result;
}

async function sweepOnce() {
  // First run establishes the boundary and chases nothing.
  if (watermark === null) {
    const top = await StoreOrders.max("order_id");
    watermark = Number(top || 0);
    return { initialised: watermark, reminded: [], escalated: [], cancelled: [] };
  }

  const pending = await StoreOrders.findAll({
    where: { order_status: RECEIVED, order_id: { [Op.gt]: watermark } },
    order: [["order_id", "ASC"]],
    limit: 100,
    raw: true,
  });

  const pendingIds = new Set(pending.map((o) => o.order_id));

  // Anything we were tracking that is no longer pending has been accepted (or
  // cancelled). Stop chasing it.
  for (const id of [...tracked.keys()]) {
    if (!pendingIds.has(id)) tracked.delete(id);
  }

  const reminded = [];
  const escalated = [];
  const cancelled = [];

  for (const order of pending) {
    if (!tracked.has(order.order_id)) {
      tracked.set(order.order_id, {
        firstSeen: Date.now(),
        reminders: 0,
        lastReminderAt: null,
        escalated: false,
      });
      continue; // its clock starts now
    }

    const entry = tracked.get(order.order_id);
    if (entry.abandoned) continue;
    const age = minutesSince(entry.firstSeen);

    // Order matters: cancel before reminding, so the last thing that happens
    // to a doomed order is not a "please accept" the vendor can no longer act on.
    if (AUTO_CANCEL && age >= CANCEL_MIN) {
      const result = await expire(order).catch((err) => {
        console.log("MFB-error-logs ~ accept sweeper ~ expire ~", err.message);
        return { ok: false };
      });
      if (result.ok) {
        const refund = result.refund?.accepted ? " +refund" : "";
        cancelled.push(`#${order.order_id}${refund}`);
        // Leave the entry in place; the order drops out of `pending` on the
        // next tick and the sweep above removes it.
      } else {
        // The cancel did not take and the order is still at status 0. Retrying
        // every 30 seconds forever is not a recovery strategy — stop, and say
        // so, because a stuck auto-cancel needs a person.
        entry.abandoned = true;
        console.log(
          `MFB ~ accept sweeper ~ auto-cancel of #${order.order_id} did not take; not retrying.`
        );
      }
      continue;
    }

    // Given up on: mark it, do NOT delete it.
    //
    // Deleting the entry while the order is still at status 0 does not stop
    // anything — the order is still in the next query's results, so 30 seconds
    // later the block above sees an untracked pending order and re-adds it with
    // a fresh clock and reminders: 0. The chase then restarts, forever. That is
    // how order #276439 was re-texted 212 times across seven identical cycles.
    //
    // The entry is instead kept and flagged, and the "no longer pending" sweep
    // above removes it for real once somebody accepts or cancels the order —
    // which also means `tracked` stays bounded by the query limit.
    if (age >= GIVE_UP_MIN) {
      if (!entry.abandoned) {
        entry.abandoned = true;
        console.log(
          `MFB ~ accept sweeper ~ giving up on #${order.order_id} after ${Math.round(age)} min ` +
            `(${entry.reminders} reminder(s) sent). It needs a human.`
        );
      }
      continue;
    }

    if (!entry.escalated && age >= ESCALATE_MIN) {
      entry.escalated = true;
      await escalate(order, age);
      escalated.push(`#${order.order_id}`);
    }

    if (dueForReminder(entry)) {
      await remind(order, entry).catch((err) =>
        console.log("MFB-error-logs ~ accept sweeper ~ remind ~", err.message)
      );
      reminded.push(`#${order.order_id} (nudge ${entry.reminders})`);
    }
  }

  if (reminded.length) {
    console.log("MFB ~ accept sweeper ~ re-alerted vendor:", reminded.join(", "));
  }
  if (escalated.length) {
    console.log("MFB ~ accept sweeper ~ ESCALATED to admin:", escalated.join(", "));
  }
  if (cancelled.length) {
    console.log("MFB ~ accept sweeper ~ AUTO-CANCELLED:", cancelled.join(", "));
  }

  return { reminded, escalated, cancelled, tracking: tracked.size };
}

/** Runs on a timer. Never throws. */
function startOrderAcceptSweeper() {
  let warned = false;
  const tick = () =>
    sweepOnce().catch((err) => {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ accept sweeper idle: " +
          (err.original?.sqlMessage || err.message) +
          ". Unaccepted orders will not be chased."
      );
    });
  tick();
  const timer = setInterval(tick, EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  sweepOnce,
  startOrderAcceptSweeper,
  REMINDER_EVERY_MIN,
  ESCALATE_MIN,
  CANCEL_MIN,
  AUTO_CANCEL,
  // exported for tests
  _reset: () => {
    tracked.clear();
    watermark = null;
  },
  _tracked: tracked,
};
