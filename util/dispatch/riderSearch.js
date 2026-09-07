// Finds every rider who could take a job, and ranks them.
//
// Two stages, in this order for a reason:
//
//   1. ELIGIBILITY — hard rules. Offline, unapproved, at capacity, already
//      rejected this job, too much cash on them. These are not penalties to be
//      outweighed by a good score; a rider who is offline cannot take the job
//      at any score.
//
//   2. RANKING — everything else, via scoring.js.
//
// Collapsing the two (a "score" that includes an offline penalty) is the
// classic mistake: a heavily-weighted good factor eventually outranks the
// penalty and the engine offers a job to someone who is asleep.
//
// DISTANCE IS NOT AN ELIGIBILITY RULE ANY MORE.
//
// This used to search expanding rings — 1→2→3→5→10→15km — with a SQL bounding
// box on dp_lat/dp_lng, and offer only inside the current ring. That was
// removed because it excluded the wrong people:
//
//   * A rider whose dp_lat/dp_lng is NULL fails a BETWEEN at every radius. A
//     rider who has never reported a position was therefore invisible to
//     dispatch permanently, however online and idle they were — observed live,
//     with a rider 300m from the pickup and a search that had already widened
//     to its maximum 15km reporting "no eligible riders in range".
//   * Single-stall kitchens often have no rider inside any sane radius, so
//     their jobs aged out having never been offered to anyone at all.
//
// So the offer now goes to EVERY online, approved, free rider. Distance still
// ranks them (nearest first) and still shows on the offer card, but it turns
// nobody away. The rider decides whether the trip is worth it — which they can
// judge better than a radius can.
const { Op } = require("sequelize");
const { DeliveryPartner, DeliveryOrder } = require("../../models");
const { haversineKm } = require("../geo");
const { config } = require("./config");
const { scoreRider } = require("./scoring");

// A wide net, but not an unbounded one: this becomes one push per rider, and a
// runaway query on a bad day should degrade rather than fan out for ever.
const MAX_FLEET = Number(process.env.DISPATCH_MAX_FLEET || 500);

/**
 * Every rider who passes the hard rules, nearest first.
 *
 * `centre` is the pickup, used only to compute the distance shown on the offer
 * and to order the results. It may be null — a job with no pickup coordinates
 * still reaches the whole fleet, it just cannot say how far away it is.
 *
 * `excludeDpIds` carries riders who already rejected or were already offered
 * this job — an offer they turned down must not come back to them.
 */
async function eligibleRiders(centre, { excludeDpIds = [], hasColumns } = {}) {
  const cfg = config();

  const where = {
    dp_online: 1,
    dp_active: 1,
    dp_verification_status: "approved",
  };
  if (excludeDpIds.length > 0) where.dp_id = { [Op.notIn]: excludeDpIds };

  // Only filter on columns the migration has actually added.
  if (hasColumns) {
    const cutoff = new Date(Date.now() - cfg.maxLocationAgeMin * 60_000);
    // A rider who has never reported a location is allowed through; only a
    // KNOWN-stale fix is disqualifying. With the radius gone this matters more,
    // not less — a null location is no longer a silent exclusion elsewhere.
    where[Op.or] = [{ dp_location_at: null }, { dp_location_at: { [Op.gte]: cutoff } }];
  }

  const riders = await DeliveryPartner.findAll({ where, limit: MAX_FLEET, raw: true });

  if (riders.length === 0) return [];

  // How many live jobs each candidate already has, in one query.
  const ids = riders.map((r) => r.dp_id);
  const activeRows = await DeliveryOrder.findAll({
    where: { dp_id: { [Op.in]: ids }, status: { [Op.in]: ["accepted", "picked_up"] } },
    attributes: ["dp_id", "do_id", "drop_lat", "drop_lng"],
    raw: true,
  });

  const activeByRider = new Map();
  for (const row of activeRows) {
    const list = activeByRider.get(row.dp_id) ?? [];
    list.push(row);
    activeByRider.set(row.dp_id, list);
  }

  const now = Date.now();
  const haveCentre =
    centre != null && Number.isFinite(centre.lat) && Number.isFinite(centre.lng);

  return riders
    .map((r) => {
      const active = activeByRider.get(r.dp_id) ?? [];
      const lat = Number(r.dp_lat);
      const lng = Number(r.dp_lng);
      // null, not a guess: "we don't know where this rider is" and "this rider
      // is at 0,0" must not look the same to anything downstream.
      const location =
        Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
      // The drop of the job they are already on, for direction matching.
      const currentDrop =
        active[0]?.drop_lat != null
          ? { lat: Number(active[0].drop_lat), lng: Number(active[0].drop_lng) }
          : null;

      return {
        dpId: r.dp_id,
        name: r.dp_name,
        location,
        currentDrop,
        vehicleType: r.dp_vehicle_type,
        rating: Number(r.dp_rating || 0),
        acceptancePct: Number(r.dp_acceptance_pct || 0),
        totalOffers: Number(r.dp_total_deliveries || 0),
        cashInHand: Number(r.dp_cash_in_hand || 0),
        activeJobs: active.length,
        maxConcurrent: hasColumns ? Number(r.dp_max_concurrent || 1) : 1,
        minutesSinceLastOffer:
          hasColumns && r.dp_last_offer_at
            ? (now - new Date(r.dp_last_offer_at).getTime()) / 60_000
            : null,
        distanceKm: haveCentre && location ? haversineKm(location, centre) : null,
      };
    })
    // At or over capacity — "not delivering any order" is the rule, and this is
    // what enforces it.
    .filter((r) => r.activeJobs < Math.max(1, r.maxConcurrent))
    // Carrying too much cash for another COD job.
    .filter((r) => r.cashInHand < cfg.maxCashInHand)
    // Nearest first. Riders with no known position sort last rather than being
    // dropped — they still get the call, they just are not presumed closest.
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

/**
 * The whole eligible fleet, ranked best-first.
 *
 * Returns { candidates, reason } — no radius, because there is no longer one.
 */
async function findCandidates(job, { excludeDpIds = [], hasColumns = false } = {}) {
  const lat = Number(job.pickup_lat);
  const lng = Number(job.pickup_lng);
  const centre =
    Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  const found = await eligibleRiders(centre, { excludeDpIds, hasColumns });

  if (found.length === 0) {
    // Deliberately not "in range" any more: range is not why. Either nobody is
    // online, or everyone online is already on a delivery.
    return { candidates: [], reason: "no online rider is free to take this job" };
  }

  const candidates = found
    .map((rider) => ({ rider, ...scoreRider(rider, job) }))
    .sort((a, b) => b.score - a.score);

  return { candidates, reason: null };
}

module.exports = { findCandidates, eligibleRiders };
