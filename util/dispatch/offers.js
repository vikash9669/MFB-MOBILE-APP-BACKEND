// The offer ledger: who was offered what, when it expires, and who won.
//
// CONCURRENCY IS THE WHOLE POINT OF THIS FILE.
//
// Three actors race for one job: the rider tapping Accept, the engine tick
// deciding the offer expired, and a second engine tick (or a second process)
// doing the same. The existing accept() was a read-then-write —
//
//     const order = await DeliveryOrder.findByPk(id);
//     if (order.status !== "offered" || order.dp_id != null) return 409;
//     await order.update({ dp_id, status: "accepted" });
//
// — which two riders can both pass before either writes. The window is small
// and real, and the symptom is two riders at one restaurant for one bag.
//
// Everything here is instead a single conditional UPDATE whose WHERE clause
// carries the state it expects, with the row count deciding the winner. No
// transaction spans a network call, and no decision is made in JS and then
// trusted to still hold a moment later.
const { QueryTypes } = require("sequelize");
const sequelize = require("../database");
const { config } = require("./config");
const { logsReady } = require("./columns");
const { describeParts } = require("./scoring");

/** Appends to the dispatch audit trail. Never throws — logging is not the job. */
async function logDispatch(doId, event, { dpId, radiusKm, candidates, detail } = {}) {
  try {
    if (!(await logsReady())) return;
    await sequelize.query(
      `INSERT INTO \`store_dispatch_logs\`
         (\`do_id\`, \`dp_id\`, \`event\`, \`radius_km\`, \`candidates\`, \`detail\`, \`created_at\`)
       VALUES (:doId, :dpId, :event, :radiusKm, :candidates, :detail, UTC_TIMESTAMP())`,
      {
        replacements: {
          doId,
          dpId: dpId ?? null,
          event,
          radiusKm: radiusKm ?? null,
          candidates: candidates ?? null,
          detail: detail ? String(detail).slice(0, 500) : null,
        },
        type: QueryTypes.INSERT,
      }
    );
  } catch (err) {
    console.log("MFB ~ dispatch log failed:", err.message);
  }
}

/**
 * Offers a job to one rider, exclusively, for offerTtlSec.
 *
 * The UNIQUE key on (do_id, dp_id) means a rider can be offered a job at most
 * once ever: a duplicate insert is caught and reported as already-offered
 * rather than creating a second live offer. That constraint is also what makes
 * two engine ticks racing to offer the same job harmless.
 */
async function createOffer(job, candidate, round) {
  const cfg = config();

  try {
    // expires_at is computed by MySQL, NOT passed as a JS Date.
    //
    // mysql2 serialises a JS Date using the *Node process* timezone into a
    // naive DATETIME, while this connection's session is UTC. On an IST host
    // that writes a value 5h30m in the future, and since every read compares
    // against UTC_TIMESTAMP(), offers would simply never expire — the first
    // rider offered a job would hold it all evening and the escalation ladder
    // would never advance. (Sequelize's own `where` builders convert properly;
    // raw replacements do not. That asymmetry is the trap.)
    const [offerId] = await sequelize.query(
      `INSERT INTO \`store_delivery_offers\`
         (\`do_id\`, \`dp_id\`, \`state\`, \`round\`, \`score\`, \`score_parts\`,
          \`distance_km\`, \`eta_min\`, \`offered_at\`, \`expires_at\`)
       VALUES (:doId, :dpId, 'pending', :round, :score, :parts,
               :distanceKm, :etaMin, UTC_TIMESTAMP(),
               DATE_ADD(UTC_TIMESTAMP(), INTERVAL :ttlSec SECOND))`,
      {
        replacements: {
          doId: job.do_id,
          dpId: candidate.rider.dpId,
          round,
          score: candidate.score,
          parts: describeParts(candidate.parts),
          distanceKm: candidate.distanceKm,
          etaMin: candidate.etaMin,
          ttlSec: Math.round(cfg.offerTtlSec),
        },
        type: QueryTypes.INSERT,
      }
    );

    // Fairness bookkeeping: the scorer favours riders who have waited longest,
    // which only works if being offered something resets the clock.
    await sequelize.query(
      "UPDATE `store_users` SET `dp_last_offer_at` = UTC_TIMESTAMP() WHERE `user_id` = :dpId",
      { replacements: { dpId: candidate.rider.dpId }, type: QueryTypes.UPDATE }
    );

    await logDispatch(job.do_id, "offer", {
      dpId: candidate.rider.dpId,
      detail: `round ${round} score ${candidate.score} ${candidate.distanceKm}km eta ${candidate.etaMin}m`,
    });

    return { ok: true, offerId, ttlSec: cfg.offerTtlSec };
  } catch (err) {
    // Duplicate key: this rider has already seen this job.
    if (err.name === "SequelizeUniqueConstraintError" || err.original?.errno === 1062) {
      return { ok: false, reason: "already offered to this rider" };
    }
    throw err;
  }
}

/**
 * Broadcast mode: offer one job to EVERY candidate at once.
 *
 * The UNIQUE key on (do_id, dp_id) that makes targeted offers idempotent is the
 * obstacle here — a re-broadcast to the same rider a round later would collide.
 * So this uses INSERT … ON DUPLICATE KEY UPDATE to *re-arm* an existing row:
 * a rider who ignored round 1 gets their offer set back to pending with a fresh
 * expiry for round 2, while riders who came online since get a new row. Riders
 * who already rejected or accepted are re-armed too — that is intended for a
 * broadcast (a "no" a minute ago may be a "yes" now) and harmless, because the
 * atomic claim still lets only one win.
 *
 * Returns how many riders now hold a live offer. Never throws.
 */
async function createBroadcastOffers(job, candidates, round, ttlSec) {
  if (candidates.length === 0) return 0;

  // One multi-row statement rather than a query per rider: a busy pickup can
  // have a dozen candidates and this runs on every re-broadcast.
  const values = candidates
    .map(
      (_, i) =>
        `(:doId, :dp${i}, 'pending', :round, :dist${i}, :eta${i}, UTC_TIMESTAMP(), ` +
        `DATE_ADD(UTC_TIMESTAMP(), INTERVAL :ttl SECOND))`
    )
    .join(", ");

  // Candidates come straight from eligibleRiders(), which returns the rider
  // fields at the top level (dpId, distanceKm) — NOT wrapped in `.rider` the way
  // findCandidates() does. Read dpId defensively so either shape works.
  const dpIdOf = (c) => c.dpId ?? c.rider?.dpId;
  const replacements = { doId: job.do_id, round, ttl: Math.round(ttlSec) };
  candidates.forEach((c, i) => {
    replacements[`dp${i}`] = dpIdOf(c);
    replacements[`dist${i}`] = c.distanceKm ?? null;
    replacements[`eta${i}`] = c.etaMin ?? null;
  });

  try {
    await sequelize.query(
      `INSERT INTO \`store_delivery_offers\`
         (\`do_id\`, \`dp_id\`, \`state\`, \`round\`, \`distance_km\`, \`eta_min\`,
          \`offered_at\`, \`expires_at\`)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
         \`state\` = 'pending',
         \`round\` = VALUES(\`round\`),
         \`distance_km\` = VALUES(\`distance_km\`),
         \`eta_min\` = VALUES(\`eta_min\`),
         \`offered_at\` = UTC_TIMESTAMP(),
         \`expires_at\` = VALUES(\`expires_at\`),
         \`responded_at\` = NULL`,
      { replacements, type: QueryTypes.INSERT }
    );
  } catch (err) {
    console.log("MFB ~ dispatch broadcast offers ~", err.message);
    return 0;
  }

  await logDispatch(job.do_id, "broadcast", {
    candidates: candidates.length,
    detail: `round ${round} to ${candidates.length} rider(s), ${Math.round(ttlSec)}s window`,
  });
  return candidates.length;
}

/** The live offer aimed at this rider right now, if any. */
async function liveOfferForRider(dpId) {
  const rows = await sequelize.query(
    `SELECT o.\`offer_id\`, o.\`do_id\`, o.\`expires_at\`, o.\`distance_km\`, o.\`eta_min\`
       FROM \`store_delivery_offers\` o
      WHERE o.\`dp_id\` = :dpId
        AND o.\`state\` = 'pending'
        AND o.\`expires_at\` > UTC_TIMESTAMP()
      ORDER BY o.\`offered_at\` ASC
      LIMIT 1`,
    { replacements: { dpId }, type: QueryTypes.SELECT }
  );
  return rows[0] ?? null;
}

/**
 * A rider accepts. Atomic, and safe against every concurrent path.
 *
 * Two conditional updates, in this order:
 *   1. Claim the OFFER   (state='pending' AND not expired) — settles rider-vs-rider
 *   2. Claim the JOB     (status='offered' AND dp_id IS NULL) — settles vs anything else
 *
 * If step 1 wins but step 2 loses, the offer is rolled back to 'withdrawn' so
 * the rider is told cleanly rather than left holding a phantom assignment.
 */
async function acceptOffer(doId, dpId) {
  const [, claimedOffer] = await sequelize.query(
    `UPDATE \`store_delivery_offers\`
        SET \`state\` = 'accepted', \`responded_at\` = UTC_TIMESTAMP()
      WHERE \`do_id\` = :doId AND \`dp_id\` = :dpId
        AND \`state\` = 'pending' AND \`expires_at\` > UTC_TIMESTAMP()`,
    { replacements: { doId, dpId }, type: QueryTypes.UPDATE }
  );

  if (Number(claimedOffer ?? 0) === 0) {
    return { ok: false, reason: "This offer has expired" };
  }

  const [, claimedJob] = await sequelize.query(
    `UPDATE \`store_delivery_orders\`
        SET \`dp_id\` = :dpId, \`status\` = 'accepted',
            \`accepted_at\` = UTC_TIMESTAMP(), \`dispatch_state\` = 'assigned'
      WHERE \`do_id\` = :doId AND \`status\` = 'offered' AND \`dp_id\` IS NULL`,
    { replacements: { doId, dpId }, type: QueryTypes.UPDATE }
  );

  if (Number(claimedJob ?? 0) === 0) {
    // Someone else has the job. Undo our offer claim.
    await sequelize.query(
      `UPDATE \`store_delivery_offers\` SET \`state\` = 'withdrawn'
        WHERE \`do_id\` = :doId AND \`dp_id\` = :dpId AND \`state\` = 'accepted'`,
      { replacements: { doId, dpId }, type: QueryTypes.UPDATE }
    );
    return { ok: false, reason: "Order is no longer available" };
  }

  // Every other pending offer for this job is now moot.
  await sequelize.query(
    `UPDATE \`store_delivery_offers\` SET \`state\` = 'withdrawn'
      WHERE \`do_id\` = :doId AND \`state\` = 'pending'`,
    { replacements: { doId }, type: QueryTypes.UPDATE }
  );

  await logDispatch(doId, "accept", { dpId });
  return { ok: true };
}

/** A rider declines. Frees the job for the next candidate immediately. */
async function rejectOffer(doId, dpId, reason) {
  const [, changed] = await sequelize.query(
    `UPDATE \`store_delivery_offers\`
        SET \`state\` = 'rejected', \`responded_at\` = UTC_TIMESTAMP()
      WHERE \`do_id\` = :doId AND \`dp_id\` = :dpId AND \`state\` = 'pending'`,
    { replacements: { doId, dpId }, type: QueryTypes.UPDATE }
  );

  if (Number(changed ?? 0) > 0) {
    await logDispatch(doId, "reject", { dpId, detail: reason });
  }
  return { ok: Number(changed ?? 0) > 0 };
}

/**
 * Expires offers nobody answered. Returns the job ids that are free again.
 *
 * Done in bulk rather than per-job timers: a timer per offer does not survive a
 * restart, and the deadline is already in the row.
 */
async function expireStaleOffers() {
  const stale = await sequelize.query(
    `SELECT \`offer_id\`, \`do_id\`, \`dp_id\` FROM \`store_delivery_offers\`
      WHERE \`state\` = 'pending' AND \`expires_at\` <= UTC_TIMESTAMP()
      LIMIT 200`,
    { type: QueryTypes.SELECT }
  );
  if (stale.length === 0) return [];

  await sequelize.query(
    `UPDATE \`store_delivery_offers\`
        SET \`state\` = 'expired', \`responded_at\` = UTC_TIMESTAMP()
      WHERE \`offer_id\` IN (:ids) AND \`state\` = 'pending'`,
    { replacements: { ids: stale.map((s) => s.offer_id) }, type: QueryTypes.UPDATE }
  );

  for (const s of stale) {
    await logDispatch(s.do_id, "expire", { dpId: s.dp_id });
  }
  return [...new Set(stale.map((s) => s.do_id))];
}

/** Riders who must not be offered this job again. */
async function excludedRiders(doId) {
  const rows = await sequelize.query(
    "SELECT `dp_id` FROM `store_delivery_offers` WHERE `do_id` = :doId",
    { replacements: { doId }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => r.dp_id);
}

/** Whether a job currently has a live offer out. */
async function hasLiveOffer(doId) {
  const rows = await sequelize.query(
    `SELECT 1 FROM \`store_delivery_offers\`
      WHERE \`do_id\` = :doId AND \`state\` = 'pending' AND \`expires_at\` > UTC_TIMESTAMP()
      LIMIT 1`,
    { replacements: { doId }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

module.exports = {
  createOffer,
  createBroadcastOffers,
  acceptOffer,
  rejectOffer,
  expireStaleOffers,
  excludedRiders,
  hasLiveOffer,
  liveOfferForRider,
  logDispatch,
};
