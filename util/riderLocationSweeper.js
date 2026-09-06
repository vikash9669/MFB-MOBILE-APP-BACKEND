// Riders who are marked online but have stopped reporting where they are.
//
// The app already handles the common case itself: services/shiftAlerts.ts
// raises a sticky notification the moment it cannot get a fix, which is faster
// than any server check and can say precisely why. This sweeper exists for the
// one case the device cannot cover — the app was force-quit, or the OS killed
// it, while the partner is still flagged online. Nothing on the phone is
// running to notice, and the only evidence left is a location that stopped
// arriving.
//
// It matters because dispatch filters on dp_online AND a fresh fix: a rider in
// this state is invisible to the engine and receives no work, with nothing on
// screen to explain the silence.
//
// Deliberately NOT the same thing as sessionSweeper, which closes the shift
// after a longer grace. This nudges first, while the shift is still salvageable.
const { Op } = require("sequelize");
const { DeliveryPartner } = require("../models");
const riderNotify = require("./riderNotify");
const { dispatchReady } = require("./dispatch/columns");

// How long a silence has to last before it is worth a notification. Sized off
// the app's own once-a-minute cadence: several missed samples, not one blip in
// a tunnel.
const STALE_MIN = Number(process.env.RIDER_LOCATION_STALE_MIN || 12);
// How often to look.
const EVERY_MS = Number(process.env.RIDER_LOCATION_SWEEP_MS || 5 * 60 * 1000);
// Don't nag. One notification per silence, not one per sweep.
const REMIND_AFTER_MIN = Number(process.env.RIDER_LOCATION_REMIND_MIN || 60);

// dp_id -> when we last told them. Process memory is the right scope: a
// restart re-notifying a still-stranded rider is the correct behaviour, and it
// avoids a column for something this transient.
const lastTold = new Map();

/**
 * One pass. Returns the dp_ids notified.
 *
 * Never throws for a partner-level failure — one unreachable device must not
 * stop the rest of the sweep.
 */
async function sweepOnce() {
  // dp_location_at only exists once the dispatch migration has run; without it
  // there is no timestamp to judge staleness by and the sweep is a no-op
  // rather than a guess.
  if (!(await dispatchReady())) return { checked: 0, notified: [] };

  const cutoff = new Date(Date.now() - STALE_MIN * 60_000);
  const partners = await DeliveryPartner.findAll({
    where: {
      dp_online: 1,
      dp_verification_status: "approved",
      // A rider who has never reported a location has a different problem
      // (they have not started tracking at all), and the app's own alert
      // covers it. Only a fix that WAS arriving and then stopped is this.
      dp_location_at: { [Op.ne]: null, [Op.lt]: cutoff },
    },
    attributes: ["dp_id", "dp_location_at"],
    raw: true,
    limit: 200,
  });

  const notified = [];
  const now = Date.now();
  for (const p of partners) {
    const told = lastTold.get(p.dp_id);
    if (told && now - told < REMIND_AFTER_MIN * 60_000) continue;

    const minutesStale = (now - new Date(p.dp_location_at).getTime()) / 60_000;
    await riderNotify.locationStale(p.dp_id, minutesStale);
    lastTold.set(p.dp_id, now);
    notified.push(p.dp_id);
  }

  // Forget riders who have started reporting again, so the next silence is
  // treated as new rather than suppressed by an hour-old entry.
  const stillStale = new Set(partners.map((p) => p.dp_id));
  for (const dpId of lastTold.keys()) {
    if (!stillStale.has(dpId)) lastTold.delete(dpId);
  }

  if (notified.length) {
    console.log(`MFB ~ rider location sweeper ~ nudged ${notified.length} silent rider(s)`);
  }
  return { checked: partners.length, notified };
}

/** Runs the sweep on a timer. Logged, never thrown. */
function startRiderLocationSweeper() {
  let warned = false;
  const tick = () =>
    sweepOnce().catch((err) => {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ rider location sweeper idle: " + (err.original?.sqlMessage || err.message)
      );
    });
  tick();
  const timer = setInterval(tick, EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = { sweepOnce, startRiderLocationSweeper, STALE_MIN, _lastTold: lastTold };
