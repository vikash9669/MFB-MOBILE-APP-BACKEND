// Decides WHEN to start looking for a rider.
//
// Dispatching the moment a restaurant accepts is the naive choice and it costs
// everyone: the rider arrives to a kitchen that has not started, and stands
// there unpaid; the restaurant has someone waiting at the counter; and the
// rider is unavailable for a job they could have completed in the meantime.
//
// So we aim for the rider to arrive just as the food does:
//
//   dispatchDelay = remainingPrep - travelTime - pickupBuffer
//
// Worked example from the brief: food ready in 15 min, rider ~7 min away,
// 3 min buffer → start searching in 5 min.
//
// The estimate is deliberately biased early. Being a few minutes early costs a
// short wait; being late costs cold food and a customer watching a stalled map.
// So travelTime uses the radius we expect to search rather than the nearest
// rider currently visible — riders move, and the nearest one now may be gone.
const { config } = require("./config");
const { travelMinutes } = require("./scoring");

/**
 * Minutes of preparation still remaining.
 *
 * Prefers the vendor's own promise (order_prep_minutes, captured when they
 * accepted) over the generic per-restaurant estimate, because a vendor saying
 * "40 minutes" at 9pm on a Saturday knows something the average does not.
 */
function remainingPrepMinutes({ prepMinutes, acceptedAt, readyInMin, now = new Date() }) {
  // Vendor's promise, counted down from when they accepted.
  if (Number.isFinite(prepMinutes) && prepMinutes > 0 && acceptedAt) {
    const elapsed = (now.getTime() - new Date(acceptedAt).getTime()) / 60_000;
    return Math.max(0, prepMinutes - elapsed);
  }
  // Fall back to the job's own estimate.
  if (Number.isFinite(readyInMin) && readyInMin > 0) return readyInMin;
  return 0;
}

/**
 * When to begin searching for this job.
 *
 * Returns { dispatchAt, delayMin, reason } — dispatchAt is a Date, possibly now.
 */
// How far we assume the winning rider will have to come, when we do not yet
// know who wins. This was "the middle of the first search ring" — 1.5km, from
// a radius ladder that no longer exists. The number is unchanged; only its
// justification had to be, since dispatch now offers fleet-wide and there is no
// first ring to take a middle of. Zero would dispatch late every time.
const ASSUMED_APPROACH_KM = 1.5;

function computeDispatchAt({
  prepMinutes,
  acceptedAt,
  readyInMin,
  expectedTravelKm,
  vehicleType,
  now = new Date(),
}) {
  const cfg = config();

  const remaining = remainingPrepMinutes({ prepMinutes, acceptedAt, readyInMin, now });

  // Straight to the offer ladder, when the deployment is configured that way.
  //
  // Everything below computes the *best* moment to start looking. That is the
  // right question for a kitchen with a real prep window, and the wrong one for
  // a stall where the food is thirty seconds away and the only hard part is
  // finding anybody at all. Computed after `remaining` so the returned figures
  // still describe the order honestly — callers log them.
  if (cfg.immediate) {
    return {
      dispatchAt: new Date(now.getTime()),
      delayMin: 0,
      remainingPrepMin: Math.round(remaining),
      travelMin: Math.round(
        travelMinutes(
          Number.isFinite(expectedTravelKm) && expectedTravelKm > 0
            ? expectedTravelKm
            : ASSUMED_APPROACH_KM,
          vehicleType,
          now
        )
      ),
      reason: "immediate on accept",
    };
  }

  // What we expect the winning rider's approach to cost. Without a distance
  // we assume the middle of the first search ring rather than zero, which
  // would dispatch late every time.
  const km = Number.isFinite(expectedTravelKm) && expectedTravelKm > 0
    ? expectedTravelKm
    : ASSUMED_APPROACH_KM;
  const travel = travelMinutes(km, vehicleType, now);

  const raw = remaining - travel - cfg.pickupBufferMin;

  // Clamp both ends: never sit on a job for longer than maxDispatchDelayMin
  // however optimistic the prep estimate, and do not bother scheduling a
  // one-minute wait.
  let delayMin = Math.min(raw, cfg.maxDispatchDelayMin);
  let reason = "prep-aware";

  if (delayMin < cfg.minDispatchDelayMin) {
    delayMin = 0;
    reason = remaining > 0 ? "food almost ready" : "no prep estimate";
  } else if (raw > cfg.maxDispatchDelayMin) {
    reason = "capped at max delay";
  }

  return {
    dispatchAt: new Date(now.getTime() + delayMin * 60_000),
    delayMin: Math.round(delayMin),
    remainingPrepMin: Math.round(remaining),
    travelMin: Math.round(travel),
    reason,
  };
}

module.exports = { computeDispatchAt, remainingPrepMinutes };
