// Ranks candidate riders for one job.
//
// The nearest rider is not the best rider. A rider 400m away who rejects two
// thirds of what they are offered costs more than one 900m away who takes
// everything: the near one burns an offer cycle, and the customer pays for it
// in minutes. So distance is the largest term but never the only one.
//
// Every factor is normalised to 0..1 where 1 is best, then combined with the
// configured weights. Normalising first is what makes the weights comparable —
// otherwise "distance in km" and "rating out of 5" would be added together and
// the weights would mean nothing.
//
// Each score carries its parts, which are written to the offer row. When a
// vendor asks why a distant rider got their order, the answer is on the record.
const { config, isPeakHour } = require("./config");
const { roadDistanceKm } = require("../geo");

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Riding speed for a vehicle type, falling back to a sane default. */
function speedFor(vehicleType) {
  const { speedKmh } = config();
  const key = String(vehicleType || "").toLowerCase();
  return speedKmh[key] ?? speedKmh.default;
}

/**
 * Minutes for a rider to cover a distance, allowing for peak-hour traffic.
 *
 * This is where a Distance Matrix call would go if one is ever enabled. It is
 * isolated here for exactly that reason: swapping estimated travel time for
 * measured travel time should touch one function, not the scorer.
 */
function travelMinutes(distanceKm, vehicleType, at = new Date()) {
  const speed = speedFor(vehicleType);
  const base = (distanceKm / speed) * 60;
  return base * (isPeakHour(at) ? config().peakFactor : 1);
}

/**
 * How well a rider's current trip points at this restaurant.
 *
 * A rider already heading north should get the northern job. Without this the
 * engine happily sends someone in the exact opposite direction because they
 * happen to be marginally closer right now.
 *
 * Returns 0.5 (neutral) when the rider has no current trip to compare against,
 * so an idle rider is neither rewarded nor punished for it.
 */
function directionScore(rider, pickup) {
  const dest = rider.currentDrop;
  if (dest == null || rider.location == null) return 0.5;

  // Cosine of the angle between "where I'm going" and "where the job is".
  const a = { x: dest.lng - rider.location.lng, y: dest.lat - rider.location.lat };
  const b = { x: pickup.lng - rider.location.lng, y: pickup.lat - rider.location.lat };
  const magA = Math.hypot(a.x, a.y);
  const magB = Math.hypot(b.x, b.y);
  if (magA === 0 || magB === 0) return 0.5;

  const cos = (a.x * b.x + a.y * b.y) / (magA * magB);
  // -1 (opposite) .. 1 (same heading) → 0 .. 1
  return clamp01((cos + 1) / 2);
}

/**
 * Scores one rider against one job. Returns 0..1 plus the breakdown.
 *
 * `maxRadiusKm` is the current search radius, used to normalise distance: at a
 * 1km radius, 900m is poor; at 10km it is excellent. Normalising against the
 * radius rather than a fixed constant keeps the term meaningful as the search
 * widens.
 */
function scoreRider(rider, job, { maxRadiusKm, at = new Date() } = {}) {
  const { weights } = config();
  const radius = maxRadiusKm || 5;

  const pickup = { lat: job.pickup_lat, lng: job.pickup_lng };
  const distanceKm = rider.location ? roadDistanceKm(rider.location, pickup) : radius;
  const etaMin = travelMinutes(distanceKm, rider.vehicleType, at);

  // Closer is better, measured against how far we are currently willing to look.
  const distance = clamp01(1 - distanceKm / radius);

  // 20 minutes to reach a restaurant is a bad pickup in any city.
  const eta = clamp01(1 - etaMin / 20);

  // A rider with no history is treated as the configured baseline rather than
  // as a 0% acceptor, which would bury every new joiner permanently.
  const acceptancePct =
    rider.totalOffers > 0 ? rider.acceptancePct : config().newRiderAcceptance;
  const acceptance = clamp01(acceptancePct / 100);

  // Ratings live on a 1..5 scale; an unrated rider scores as average.
  const rating = rider.rating > 0 ? clamp01((rider.rating - 1) / 4) : 0.6;

  // Free capacity. A rider at their limit should not be here at all, but score
  // 0 rather than assume the caller filtered correctly.
  const capacity = Math.max(1, rider.maxConcurrent);
  const load = clamp01(1 - rider.activeJobs / capacity);

  const direction = directionScore(rider, pickup);

  // Waiting longer for work is better, saturating at 30 minutes so a rider who
  // has been idle all morning does not outrank a much closer one forever.
  const idleMin = rider.minutesSinceLastOffer ?? 30;
  const idle = clamp01(idleMin / 30);

  const parts = { distance, eta, acceptance, rating, load, direction, idle };

  // Weights need not sum to 100 — normalise so any set behaves sensibly.
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0) || 1;
  const score =
    Object.entries(parts).reduce((sum, [key, value]) => sum + value * (weights[key] ?? 0), 0) /
    totalWeight;

  return {
    score: Math.round(score * 1000) / 1000,
    distanceKm: Math.round(distanceKm * 100) / 100,
    etaMin: Math.round(etaMin),
    parts,
  };
}

/** Compact breakdown for the offer row — readable in a DB client, not JSON soup. */
function describeParts(parts) {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ")
    .slice(0, 500);
}

module.exports = { scoreRider, travelMinutes, directionScore, describeParts, speedFor };
