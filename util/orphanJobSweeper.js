// Live orders that never made it into the rider pool.
//
// queueDeliveryJob runs exactly once, when the order is created, and it
// swallows its own errors on purpose: a dispatch problem must never fail an
// order that is already committed and, on the online path, already paid for.
// The cost of that choice is that a transient failure — a geocoding timeout, a
// momentary database blip — leaves a live order with no job. No rider is ever
// offered it, nothing retries, and the only way anyone finds out is a customer
// ringing to ask where their food is.
//
// It is not hypothetical: 21 orders in a 30-day window were sitting like this
// on live data when this was written, and one appeared during an end-to-end
// test in the space of a single afternoon.
//
// So this looks for them and queues them. createJobForOrder returns any
// existing job rather than making a second one, so racing the original call is
// harmless.
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");
const { createJobForOrder } = require("./deliveryDispatch");

// Only rescue orders that could still plausibly be delivered. An order from
// last week was resolved some other way or abandoned, and queueing it now would
// send a rider to collect food nobody is cooking.
const WINDOW_MIN = Number(process.env.ORPHAN_JOB_WINDOW_MIN || 180);
const BATCH = Number(process.env.ORPHAN_JOB_BATCH || 10);
const EVERY_MS = 60000;

// Give up on one that keeps failing instead of retrying it every minute for
// ever. The accept sweeper used to make exactly that mistake and turned a
// single stuck order into hundreds of messages.
const MAX_ATTEMPTS = Number(process.env.ORPHAN_JOB_MAX_ATTEMPTS || 5);

// order_id -> failed attempts so far. In-process only: a restart re-tries, and
// by then the transient cause has usually cleared.
const attempts = new Map();

/**
 * Finds live orders with no delivery job and queues them.
 *
 * Statuses 0 (Received) and 1 (Processed) are the two that still need a rider.
 * Anything cancelled or delivered is deliberately out of scope.
 *
 * NOTE ON TIME: order_received_time is written in the session timezone, which
 * util/database.js pins to +05:30 — so the window compares against NOW(), not
 * UTC_TIMESTAMP(). Using UTC here would make every row look five and a half
 * hours younger than it is and quietly widen the window.
 */
async function sweepOrphanJobs() {
  const rows = await sequelize.query(
    `SELECT o.\`order_id\`
       FROM \`store_orders\` o
      WHERE o.\`order_status\` IN (0, 1)
        AND o.\`order_received_time\` > DATE_SUB(NOW(), INTERVAL :mins MINUTE)
        AND NOT EXISTS (
              SELECT 1 FROM \`store_delivery_orders\` d
               WHERE d.\`source_order_id\` = o.\`order_id\`)
      ORDER BY o.\`order_id\` ASC
      LIMIT :batch`,
    { replacements: { mins: WINDOW_MIN, batch: BATCH }, type: QueryTypes.SELECT }
  );

  const queued = [];
  let gaveUp = 0;

  for (const row of rows) {
    const orderId = row.order_id;
    const tried = attempts.get(orderId) ?? 0;

    if (tried >= MAX_ATTEMPTS) {
      gaveUp += 1;
      continue;
    }

    try {
      const job = await createJobForOrder(orderId);
      if (job == null) {
        // The order vanished, or dispatch declined it. Count it as an attempt
        // so a permanently unqueueable order cannot spin here for ever.
        attempts.set(orderId, tried + 1);
        continue;
      }
      attempts.delete(orderId);
      queued.push(`#${orderId} -> job ${job.do_id}`);
    } catch (err) {
      const now = tried + 1;
      attempts.set(orderId, now);
      if (now === MAX_ATTEMPTS) {
        console.log(
          `MFB ~ orphan job sweeper ~ giving up on order #${orderId} after ` +
            `${MAX_ATTEMPTS} attempts: ${err.message}. No rider will be offered it.`
        );
      }
    }
  }

  if (queued.length > 0) {
    console.log(
      `MFB ~ orphan job sweeper ~ rescued ${queued.length} order(s) with no rider job: ` +
        queued.join(", ")
    );
  }

  return { found: rows.length, queued: queued.length, gaveUp };
}

function startOrphanJobSweeper() {
  let warned = false;
  const run = () =>
    sweepOrphanJobs().catch((err) => {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ orphan job sweeper idle: " +
          (err.original?.sqlMessage || err.message) +
          ". Orders that miss dispatch will not be recovered."
      );
    });

  run();
  const timer = setInterval(run, EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  sweepOrphanJobs,
  startOrphanJobSweeper,
  // exported for tests
  _attempts: attempts,
  WINDOW_MIN,
  MAX_ATTEMPTS,
};
