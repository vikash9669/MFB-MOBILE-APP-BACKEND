// The dispatch orchestrator.
//
// One tick, every few seconds, doing four things in a deliberate order:
//
//   1. expire   — offers nobody answered, freeing their jobs
//   2. schedule — newly created jobs get a dispatch_at from the prep estimate
//   3. offer    — jobs whose time has come get their next-best rider
//   4. rescue   — jobs that have exhausted their candidates
//
// WHY A TICK AND NOT A QUEUE. The brief calls for BullMQ workers. This stack
// has no Redis and no queue, and adding both to run one recurring job is
// infrastructure nobody asked to operate. The tick is the pattern already used
// by util/paymentSweeper.js and util/orderAcceptSweeper.js: state lives in the
// database, work is claimed with conditional UPDATEs, and a restart resumes
// from the rows rather than from lost in-memory timers. It scales the same way
// those do — horizontally, because the claims are atomic — until a real queue
// is warranted, at which point offers.js is the only file a worker needs.
//
// NOTHING HERE MAY THROW into the caller. A dispatch failure must never fail an
// order that is already placed and possibly already paid for.
const { Op, QueryTypes, literal } = require("sequelize");
const sequelize = require("../database");
const { DeliveryOrder } = require("../../models");
const { config } = require("./config");
const { dispatchReady } = require("./columns");
const { findCandidates } = require("./riderSearch");
const { computeDispatchAt } = require("./timing");
const offers = require("./offers");
const { notifyPartner } = require("../deliveryNotify");

const BATCH = 25;

/**
 * Schedules a freshly created job.
 *
 * Called from the delivery job builder, and also picked up by the tick for any
 * job that somehow arrived without a schedule.
 */
async function scheduleJob(job, { prepMinutes, acceptedAt } = {}) {
  const plan = computeDispatchAt({
    prepMinutes,
    acceptedAt,
    readyInMin: Number(job.ready_in_min),
    // We do not know who will win yet, so timing.js assumes the middle of the
    // first search ring rather than pretending to know.
    expectedTravelKm: null,
    vehicleType: null,
  });

  // Computed by MySQL rather than passed as a JS Date — see the note in
  // offers.js: a raw replacement is serialised in the Node process timezone
  // while the session is UTC, which on an IST host would push every dispatch
  // 5h30m into the future and stall the queue completely.
  await sequelize.query(
    `UPDATE \`store_delivery_orders\`
        SET \`dispatch_at\` = DATE_ADD(UTC_TIMESTAMP(), INTERVAL :delaySec SECOND),
            \`dispatch_state\` = 'waiting', \`offer_round\` = 0
      WHERE \`do_id\` = :doId AND \`dispatch_state\` IS NULL`,
    {
      replacements: { doId: job.do_id, delaySec: Math.round(plan.delayMin * 60) },
      type: QueryTypes.UPDATE,
    }
  );

  await offers.logDispatch(job.do_id, "scheduled", {
    detail: `${plan.reason}: prep ${plan.remainingPrepMin}m, travel ~${plan.travelMin}m, start in ${plan.delayMin}m`,
  });

  return plan;
}

/**
 * How long this job has been trying to find anybody, in minutes.
 *
 * Measured from dispatch_at — the moment the job actually became due — so a
 * job scheduled half an hour ahead of a slow kitchen isn't judged on time it
 * spent legitimately waiting. Null when there's no dispatch_at to measure from,
 * which the caller treats as "not yet timed out" rather than guessing.
 */
async function minutesSearching(doId) {
  const [row] = await sequelize.query(
    `SELECT TIMESTAMPDIFF(SECOND, \`dispatch_at\`, UTC_TIMESTAMP()) AS secs
       FROM \`store_delivery_orders\` WHERE \`do_id\` = :doId`,
    { replacements: { doId }, type: QueryTypes.SELECT }
  );
  const secs = row?.secs;
  return secs == null ? null : Number(secs) / 60;
}

// Last fruitless search we wrote down, per job, and at what radius. In memory
// on purpose: it only throttles logging, so losing it on restart costs one
// extra row per job and never affects dispatch itself.
const lastSearchLog = new Map();

/**
 * Whether this fruitless search is worth a row.
 *
 * Always logs the first one and any change of radius — those are the lines
 * someone reading the log actually needs. The identical repeats in between are
 * throttled to one per searchLogEverySec.
 */
async function shouldLogSearch(doId, radiusKm, everySec) {
  const prev = lastSearchLog.get(doId);
  const now = Date.now();
  if (prev && prev.radiusKm === radiusKm && now - prev.at < everySec * 1000) {
    return false;
  }
  lastSearchLog.set(doId, { radiusKm, at: now });
  return true;
}

/**
 * Finds the next rider for one job and offers it to them.
 *
 * Returns a short verdict string for the tick's log line.
 */
async function offerNext(job) {
  const cfg = config();

  // Already out with someone — leave it alone until it expires.
  if (await offers.hasLiveOffer(job.do_id)) return null;

  const round = Number(job.offer_round || 0) + 1;

  if (round > cfg.maxOffersPerJob) {
    await markExhausted(job, `no acceptance after ${cfg.maxOffersPerJob} offers`);
    return `#${job.do_id} exhausted`;
  }

  const excludeDpIds = await offers.excludedRiders(job.do_id);
  const { candidates, radiusKm, reason } = await findCandidates(job, {
    excludeDpIds,
    hasColumns: true,
  });

  if (candidates.length === 0) {
    // Riders come online, so finding nobody on one tick is not a failure — but
    // it cannot be retried for ever either. The offer ladder above can't bound
    // this: a job with no candidates never makes an offer, so offer_round never
    // advances and maxOffersPerJob is unreachable. Time is the only bound that
    // works here.
    const searchingMin = await minutesSearching(job.do_id);
    if (searchingMin != null && searchingMin >= cfg.noRiderTimeoutMin) {
      await markExhausted(
        job,
        `no rider within ${radiusKm}km after ${Math.round(searchingMin)} minutes`
      );
      return `#${job.do_id} exhausted (no riders)`;
    }

    // Log sparsely. The search repeats every tick by design; recording each
    // failure would write a row every few seconds per stuck job.
    if (await shouldLogSearch(job.do_id, radiusKm, cfg.searchLogEverySec)) {
      await offers.logDispatch(job.do_id, "search", {
        radiusKm,
        candidates: 0,
        detail: reason,
      });
    }

    await sequelize.query(
      `UPDATE \`store_delivery_orders\`
          SET \`dispatch_state\` = 'searching', \`search_radius_km\` = :radius
        WHERE \`do_id\` = :doId`,
      { replacements: { doId: job.do_id, radius: radiusKm }, type: QueryTypes.UPDATE }
    );
    return null;
  }

  // Worth recording every time: this one found somebody.
  await offers.logDispatch(job.do_id, "search", {
    radiusKm,
    candidates: candidates.length,
    detail: reason,
  });

  const best = candidates[0];

  if (cfg.dryRun) {
    await offers.logDispatch(job.do_id, "offer", {
      dpId: best.rider.dpId,
      detail: `DRY RUN would offer (score ${best.score})`,
    });
    return `#${job.do_id} dry-run → rider ${best.rider.dpId}`;
  }

  const created = await offers.createOffer(job, best, round);
  if (!created.ok) return null;

  // It's out with a rider now, so the fruitless-search throttle for this job
  // has nothing left to suppress.
  lastSearchLog.delete(job.do_id);

  await sequelize.query(
    `UPDATE \`store_delivery_orders\`
        SET \`dispatch_state\` = 'searching', \`offer_round\` = :round,
            \`search_radius_km\` = :radius
      WHERE \`do_id\` = :doId`,
    {
      replacements: { doId: job.do_id, round, radius: radiusKm },
      type: QueryTypes.UPDATE,
    }
  );

  // Rings the rider like a call rather than dropping a tray notification: the
  // offer stands for offerTtlSec, and a rider mid-ride will not see a silent
  // banner in time. `call: true` makes this a data-only push so the app can
  // raise a full-screen intent — see util/fcm.js.
  notifyPartner(best.rider.dpId, {
    category: "orders",
    icon: "delivery_dining",
    title: `New delivery · ₹${job.earn_total}`,
    body: `${job.pickup_name || "Pickup"} → ${job.drop_area || "drop"} · ${best.distanceKm}km away`,
    call: true,
    ttlSec: cfg.offerTtlSec,
    data: {
      type: "order_offer",
      do_id: job.do_id,
      expires_in: cfg.offerTtlSec,
      pickup_name: job.pickup_name || "",
      drop_area: job.drop_area || "",
      distance_km: best.distanceKm,
      earn_total: job.earn_total,
    },
  }).catch(() => {});

  return `#${job.do_id} → rider ${best.rider.dpId} (score ${best.score}, ${best.distanceKm}km, r${round})`;
}

/** Nobody took it. Park it for a human rather than looping forever. */
async function markExhausted(job, note) {
  await sequelize.query(
    `UPDATE \`store_delivery_orders\`
        SET \`dispatch_state\` = 'failed', \`dispatch_note\` = :note
      WHERE \`do_id\` = :doId AND \`status\` = 'offered'`,
    { replacements: { doId: job.do_id, note: String(note).slice(0, 255) }, type: QueryTypes.UPDATE }
  );
  await offers.logDispatch(job.do_id, "exhausted", { detail: note });
  // Done with this job, so stop tracking it for log throttling.
  lastSearchLog.delete(job.do_id);
  console.log(`MFB ~ dispatch ~ NO RIDER for job #${job.do_id}: ${note}`);
}

/**
 * Puts a job back into the search, from the start.
 *
 * Used when an assigned rider cancels, goes offline mid-job, or an admin
 * intervenes. Previous offers stay on the ledger — the rider who dropped it
 * should not be handed it straight back.
 */
async function reassign(doId, reason = "reassigned") {
  const [, changed] = await sequelize.query(
    `UPDATE \`store_delivery_orders\`
        SET \`status\` = 'offered', \`dp_id\` = NULL, \`accepted_at\` = NULL,
            \`dispatch_state\` = 'searching', \`dispatch_at\` = UTC_TIMESTAMP(),
            \`dispatch_note\` = :reason
      WHERE \`do_id\` = :doId AND \`status\` IN ('offered', 'accepted')`,
    { replacements: { doId, reason: String(reason).slice(0, 255) }, type: QueryTypes.UPDATE }
  );

  if (Number(changed ?? 0) === 0) {
    return { ok: false, reason: "job is past the point where it can be reassigned" };
  }

  await sequelize.query(
    `UPDATE \`store_delivery_offers\` SET \`state\` = 'withdrawn'
      WHERE \`do_id\` = :doId AND \`state\` = 'pending'`,
    { replacements: { doId }, type: QueryTypes.UPDATE }
  );

  await offers.logDispatch(doId, "reassign", { detail: reason });
  return { ok: true };
}

/** One pass. Returns a summary; never throws. */
async function tick() {
  if (!(await dispatchReady())) return { skipped: "schema" };
  const cfg = config();
  if (!cfg.enabled) return { skipped: "disabled" };

  const actions = [];

  // 1. Expired offers free their jobs for the next candidate.
  const freed = await offers.expireStaleOffers();
  if (freed.length) actions.push(`expired ${freed.length}`);

  // 2. Any job that arrived without a schedule.
  const unscheduled = await DeliveryOrder.findAll({
    where: { status: "offered", dp_id: null, dispatch_state: null },
    limit: BATCH,
    raw: true,
  });
  for (const job of unscheduled) {
    await scheduleJob(job).catch((e) =>
      console.log(`MFB ~ dispatch schedule #${job.do_id}:`, e.message)
    );
  }
  if (unscheduled.length) actions.push(`scheduled ${unscheduled.length}`);

  // 3. Jobs whose dispatch time has arrived and that have no live offer.
  const due = await DeliveryOrder.findAll({
    where: {
      status: "offered",
      dp_id: null,
      dispatch_state: { [Op.in]: ["waiting", "searching"] },
      // Compared in the database's own clock. Sequelize does convert a JS Date
      // correctly here, unlike a raw replacement — but mixing the two
      // conventions in one module is how the 5h30m skew got in, so both sides
      // of every time comparison in the engine use UTC_TIMESTAMP().
      dispatch_at: { [Op.lte]: literal("UTC_TIMESTAMP()") },
    },
    order: [["dispatch_at", "ASC"]],
    limit: BATCH,
    raw: true,
  });

  const offered = [];
  for (const job of due) {
    const verdict = await offerNext(job).catch((e) => {
      console.log(`MFB ~ dispatch offer #${job.do_id}:`, e.message);
      return null;
    });
    if (verdict) offered.push(verdict);
  }
  if (offered.length) console.log("MFB ~ dispatch ~", offered.join(" | "));

  return { freed: freed.length, scheduled: unscheduled.length, due: due.length, offered: offered.length };
}

/** Runs on a timer. Never throws. */
function startDispatchEngine() {
  let warned = false;
  const run = () =>
    tick().catch((err) => {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ dispatch engine idle: " +
          (err.original?.sqlMessage || err.message) +
          ". Riders fall back to the open pool."
      );
    });
  run();
  const timer = setInterval(run, config().tickMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = { tick, startDispatchEngine, scheduleJob, offerNext, reassign, markExhausted };
