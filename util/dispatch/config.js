// Every number the dispatch engine reasons with, in one place.
//
// These are commercial and operational levers, not implementation details: the
// right offer window in Nimbahera at 8pm is not the right one at 3pm, and
// nobody should need a deploy to find that out. Read through functions rather
// than captured at import so a change takes effect on the next tick.
//
// Weights are normalised at use, so they do not have to sum to 1 — you can set
// DISPATCH_W_DISTANCE=50 without recomputing the other five.

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === "" ? d : String(v) === "true");

/**
 * Scoring weights. Defaults follow the brief's split, which is a reasonable
 * starting point for a single-city operation:
 *   distance 35 · eta 20 · acceptance 15 · rating 10 · load 10 · direction 10
 */
const weights = () => ({
  distance: num(process.env.DISPATCH_W_DISTANCE, 35),
  eta: num(process.env.DISPATCH_W_ETA, 20),
  acceptance: num(process.env.DISPATCH_W_ACCEPTANCE, 15),
  rating: num(process.env.DISPATCH_W_RATING, 10),
  load: num(process.env.DISPATCH_W_LOAD, 10),
  direction: num(process.env.DISPATCH_W_DIRECTION, 10),
  // Not in the brief's formula, but without it the riders parked nearest the
  // busiest restaurant take every job and the rest of the fleet earns nothing.
  // Small by design: fairness should break ties, not beat a much closer rider.
  idle: num(process.env.DISPATCH_W_IDLE, 5),
});

/**
 * Expanding search radii, in km. Stops as soon as enough candidates appear.
 *
 * The ladder ends at 15 rather than 10 because this app is used by single-stall
 * kitchens as well as restaurants, and a stall does not sit in a dense delivery
 * market — outside the couple of streets around it there may be no rider at
 * all, and a job that finds nobody by 10km was simply being abandoned. The
 * early rings are unchanged, so a nearby rider is still always preferred; the
 * extra ring only ever runs when the closer ones came back empty.
 *
 * Widening is not free: 15km is a long approach on a bike, and scoring
 * normalises distance against the radius actually searched, so a 12km rider
 * found at 15km scores far worse than a 2km rider found at 3km. That is the
 * intended shape — reach further only when the alternative is nobody.
 */
const radii = () =>
  String(process.env.DISPATCH_RADII_KM || "1,2,3,5,10,15")
    .split(",")
    .map((r) => Number(r.trim()))
    .filter((r) => Number.isFinite(r) && r > 0)
    .sort((a, b) => a - b);

const config = () => ({
  weights: weights(),
  radii: radii(),

  // Enough candidates to stop widening the search. Ranking three riders and
  // taking the best is worth far more than ranking thirty.
  minCandidates: num(process.env.DISPATCH_MIN_CANDIDATES, 3),
  // Hard cap on how many riders we will ever offer one job to before giving up.
  maxOffersPerJob: num(process.env.DISPATCH_MAX_OFFERS, 8),

  // How long a job may keep finding nobody before it is handed to a human.
  //
  // maxOffersPerJob bounds the *offer* ladder, but a job with zero candidates
  // never makes an offer, so it never advances a round and that cap can never
  // be reached. Without this a pickup with no rider within the widest radius
  // re-searches every tick for ever — one row in store_dispatch_logs each
  // time, which is how a dead job quietly becomes hundreds of thousands of
  // writes a day. Counted from dispatch_at.
  noRiderTimeoutMin: num(process.env.DISPATCH_NO_RIDER_TIMEOUT_MIN, 10),

  // How often to record a fruitless search. The search itself is cheap and
  // must stay frequent — a rider coming online should be found within seconds.
  // Writing down every one of those failures is what is expensive.
  searchLogEverySec: num(process.env.DISPATCH_SEARCH_LOG_EVERY_SEC, 60),

  // How long a rider has to take an offer before it moves on. The brief says
  // 20s; the partner app polls, so this must comfortably exceed the poll
  // interval or an offer can expire before the rider is even shown it.
  offerTtlSec: num(process.env.DISPATCH_OFFER_TTL_SEC, 25),

  /**
   * Call a rider the moment the vendor accepts, instead of working backwards
   * from their prep estimate.
   *
   * ON by default, because most kitchens on this platform are stalls and small
   * counters: prep is minutes, the "estimate" is a number tapped in a hurry,
   * and holding the job back to time a perfect arrival mostly means the food is
   * bagged with nobody on the way. Finding a rider takes real time — an offer
   * ladder, riders who do not answer — and starting that clock at accept is the
   * difference between a rider arriving late and not arriving at all.
   *
   * The cost is real and worth stating: a rider may reach a kitchen that has
   * not finished and wait, unpaid. Set DISPATCH_IMMEDIATE=false to restore the
   * prep-aware schedule (see util/dispatch/timing.js), which is the better
   * choice for a deployment of larger restaurants with honest prep times.
   */
  immediate: bool(process.env.DISPATCH_IMMEDIATE, true),

  // Dispatch timing. A rider should arrive as the food does — not before
  // (they wait, unpaid) and not after (the food sits, the customer waits).
  // Only consulted when `immediate` is false.
  pickupBufferMin: num(process.env.DISPATCH_PICKUP_BUFFER_MIN, 3),
  // Never delay dispatch beyond this, however long the prep estimate says.
  maxDispatchDelayMin: num(process.env.DISPATCH_MAX_DELAY_MIN, 20),
  // Below this remaining prep time, just dispatch now.
  minDispatchDelayMin: num(process.env.DISPATCH_MIN_DELAY_MIN, 1),

  // Average riding speed by vehicle, km/h, used for ETA when we have no
  // traffic data. Deliberately conservative: an optimistic ETA produces a
  // rider who is late, which is worse than one who waits a minute.
  speedKmh: {
    bike: num(process.env.DISPATCH_SPEED_BIKE, 22),
    scooter: num(process.env.DISPATCH_SPEED_SCOOTER, 22),
    cycle: num(process.env.DISPATCH_SPEED_CYCLE, 12),
    walking: num(process.env.DISPATCH_SPEED_WALKING, 5),
    default: num(process.env.DISPATCH_SPEED_DEFAULT, 18),
  },
  // Multiplies travel time during peak hours, standing in for live traffic.
  peakFactor: num(process.env.DISPATCH_PEAK_FACTOR, 1.35),
  peakHours: String(process.env.DISPATCH_PEAK_HOURS || "12-15,19-22"),

  // A GPS fix older than this is not a location, it is a guess.
  maxLocationAgeMin: num(process.env.DISPATCH_MAX_LOCATION_AGE_MIN, 10),
  // Riders below this acceptance rate still get offers, just ranked lower.
  // No hard cutoff: a hard one starves new riders, who have no history at all.
  newRiderAcceptance: num(process.env.DISPATCH_NEW_RIDER_ACCEPTANCE, 70),

  // Cash-in-hand ceiling. A rider carrying too much cash should not be handed
  // another COD job — that is a float problem, not a routing one.
  maxCashInHand: num(process.env.DISPATCH_MAX_CASH_IN_HAND, 3000),

  // Batching. Off by default: it is the feature most likely to make a late
  // delivery later, and it should be switched on deliberately per city.
  batching: {
    enabled: bool(process.env.DISPATCH_BATCHING, false),
    maxOrders: num(process.env.DISPATCH_BATCH_MAX_ORDERS, 2),
    // Two pickups further apart than this are not one trip.
    maxPickupGapKm: num(process.env.DISPATCH_BATCH_PICKUP_GAP_KM, 1),
    maxDropGapKm: num(process.env.DISPATCH_BATCH_DROP_GAP_KM, 2),
    // Pickup windows must overlap within this many minutes.
    maxReadyGapMin: num(process.env.DISPATCH_BATCH_READY_GAP_MIN, 8),
  },

  // Master switch. When false the engine schedules and logs but never offers,
  // which is how you watch it think before letting it act.
  enabled: bool(process.env.DISPATCH_ENABLED, true),
  dryRun: bool(process.env.DISPATCH_DRY_RUN, false),

  // How often the engine ticks.
  tickMs: num(process.env.DISPATCH_TICK_MS, 5000),
});

/** True when `date` falls in a configured peak window. */
function isPeakHour(date = new Date()) {
  const hour = date.getHours();
  return config()
    .peakHours.split(",")
    .some((range) => {
      const [from, to] = range.split("-").map((h) => Number(h.trim()));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
      return hour >= from && hour < to;
    });
}

module.exports = { config, isPeakHour };
