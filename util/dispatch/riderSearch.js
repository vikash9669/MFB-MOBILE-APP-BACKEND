// Finds and ranks riders who could take a job.
//
// Two stages, in this order for a reason:
//
//   1. ELIGIBILITY — hard rules. Offline, unapproved, at capacity, stale GPS,
//      already rejected this job, too much cash on them. These are not
//      penalties to be outweighed by a good score; a rider who is offline
//      cannot take the job at any score.
//
//   2. RANKING — everything else, via scoring.js.
//
// Collapsing the two (a "score" that includes an offline penalty) is the
// classic mistake: a heavily-weighted good factor eventually outranks the
// penalty and the engine offers a job to someone who is asleep.
//
// The radius expands 1→2→3→5→10km and stops as soon as enough candidates are
// found. The alternative — always searching 10km — makes the common case (a
// rider is right there) pay the cost of the rare one.
//
// GEO NOTE: this filters in SQL with a bounding box, then refines in JS with
// haversine. MySQL has spatial types, but dp_lat/dp_lng are plain DECIMALs on
// an existing table, and a bounding box on two indexed-able columns gets us the
// same shortlist without a schema change or a spatial index to maintain.
const { Op } = require("sequelize");
const { DeliveryPartner, DeliveryOrder } = require("../../models");
const { haversineKm } = require("../geo");
const { config } = require("./config");
const { scoreRider } = require("./scoring");

const KM_PER_DEG_LAT = 111;

/** Degrees of longitude per km shrinks as you leave the equator. */
const kmPerDegLng = (lat) => KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || KM_PER_DEG_LAT;

/** A lat/lng box that fully contains the search circle. */
function boundingBox(centre, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / kmPerDegLng(centre.lat);
  return {
    minLat: centre.lat - dLat,
    maxLat: centre.lat + dLat,
    minLng: centre.lng - dLng,
    maxLng: centre.lng + dLng,
  };
}

/**
 * Riders inside the box who pass every hard rule.
 *
 * `excludeDpIds` carries riders who already rejected or were already offered
 * this job — an offer they turned down must not come back to them.
 */
async function eligibleRiders(centre, radiusKm, { excludeDpIds = [], hasColumns } = {}) {
  const box = boundingBox(centre, radiusKm);
  const cfg = config();

  const where = {
    dp_online: 1,
    dp_active: 1,
    dp_verification_status: "approved",
    dp_lat: { [Op.between]: [box.minLat, box.maxLat] },
    dp_lng: { [Op.between]: [box.minLng, box.maxLng] },
  };
  if (excludeDpIds.length > 0) where.dp_id = { [Op.notIn]: excludeDpIds };

  // Only filter on columns the migration has actually added.
  if (hasColumns) {
    const cutoff = new Date(Date.now() - cfg.maxLocationAgeMin * 60_000);
    // A rider who has never reported a location is allowed through on the
    // strength of dp_lat/dp_lng; only a KNOWN-stale fix is disqualifying.
    where[Op.or] = [{ dp_location_at: null }, { dp_location_at: { [Op.gte]: cutoff } }];
  }

  const riders = await DeliveryPartner.findAll({
    where,
    // A wide net at the SQL layer; the real cut happens in JS below.
    limit: 200,
    raw: true,
  });

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

  return riders
    .map((r) => {
      const active = activeByRider.get(r.dp_id) ?? [];
      const location = { lat: Number(r.dp_lat), lng: Number(r.dp_lng) };
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
        distanceKm: haversineKm(location, centre),
      };
    })
    // The box is a square; the search is a circle.
    .filter((r) => r.distanceKm <= radiusKm)
    // At or over capacity — nothing to do with how good they are.
    .filter((r) => r.activeJobs < Math.max(1, r.maxConcurrent))
    // Carrying too much cash for another COD job.
    .filter((r) => r.cashInHand < cfg.maxCashInHand);
}

/**
 * Expands the radius until enough candidates are found, then ranks them.
 *
 * Returns { candidates, radiusKm, widened } — candidates best-first.
 */
async function findCandidates(job, { excludeDpIds = [], hasColumns = false } = {}) {
  const cfg = config();
  const centre = { lat: Number(job.pickup_lat), lng: Number(job.pickup_lng) };

  if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) {
    return { candidates: [], radiusKm: null, reason: "job has no pickup coordinates" };
  }

  let found = [];
  let usedRadius = cfg.radii[cfg.radii.length - 1];

  for (const radius of cfg.radii) {
    found = await eligibleRiders(centre, radius, { excludeDpIds, hasColumns });
    usedRadius = radius;
    if (found.length >= cfg.minCandidates) break;
  }

  if (found.length === 0) {
    return { candidates: [], radiusKm: usedRadius, reason: "no eligible riders in range" };
  }

  const candidates = found
    .map((rider) => ({ rider, ...scoreRider(rider, job, { maxRadiusKm: usedRadius }) }))
    .sort((a, b) => b.score - a.score);

  return { candidates, radiusKm: usedRadius, widened: usedRadius > cfg.radii[0] };
}

module.exports = { findCandidates, eligibleRiders, boundingBox };
