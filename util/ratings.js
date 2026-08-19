// Rider ratings: recording one, and keeping dp_rating in step with them.
//
// store_delivery_partners.dp_rating is a CACHE, not the truth. The truth is the
// set of rows in store_delivery_ratings; dp_rating exists because dispatch
// scoring reads it on every candidate for every job, and an AVG() across a
// growing table on that path would be a self-inflicted wound.
//
// Everything here is written so a rating can never damage a delivery. A rating
// arrives after the food does — the transaction it belongs to is already over —
// so nothing in this file may throw into a caller's success path.
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");
const { DeliveryPartner } = require("../models");
const { ratingsReady } = require("./ratingColumns");

/** Stars are 1–5 whole numbers. Anything else is a client bug, not a rating. */
function parseStars(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

/**
 * The quick-pick reasons, normalised.
 *
 * Accepts an array or a comma-separated string, because the two apps send
 * different shapes and neither is worth a breaking change. Capped at 6 and 255
 * characters to match the column, trimmed of blanks, de-duplicated.
 */
function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const cleaned = [
    ...new Set(
      list
        .map((t) => String(t).trim().toLowerCase())
        .filter((t) => t && /^[a-z0-9_-]{1,24}$/.test(t))
    ),
  ].slice(0, 6);
  const joined = cleaned.join(",");
  return joined.length ? joined.slice(0, 255) : null;
}

function parseComment(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length ? text.slice(0, 500) : null;
}

/**
 * Recomputes a partner's cached average from their ratings.
 *
 * Deliberately a full recompute rather than an incremental nudge: an edited
 * rating (the customer changes their mind within the window) would make an
 * incremental update wrong, and the row count here is small per rider.
 *
 * A partner with no ratings goes to 0, not 5. Scoring treats 0 as "unrated" and
 * substitutes a neutral value; leaving them at 5 would mean an unproven rider
 * outranks one with a real 4.8.
 */
async function recomputeRating(dpId) {
  const [row] = await sequelize.query(
    "SELECT AVG(`stars`) avg_stars, COUNT(*) n FROM `store_delivery_ratings` WHERE `dp_id` = :dpId",
    { replacements: { dpId }, type: QueryTypes.SELECT }
  );
  const count = Number(row?.n || 0);
  const avg = count > 0 ? Number(row.avg_stars) : 0;
  // DECIMAL(3,2) — two places is all the column can hold anyway.
  const rounded = Math.round(avg * 100) / 100;
  await DeliveryPartner.update({ dp_rating: rounded }, { where: { dp_id: dpId } });
  return { rating: rounded, count };
}

/**
 * Records (or replaces) the customer's rating for one delivery.
 *
 * Upserts on do_id: a customer who taps 3 stars and immediately corrects it to
 * 4 has changed their mind, not rated twice. Returning early on a duplicate
 * instead would leave the wrong number on a rider's record for ever.
 *
 * Returns { ok, rating, count } or { ok: false, reason }.
 */
async function rateDelivery({ doId, dpId, sourceOrderId, customerId, stars, tags, comment }) {
  if (!(await ratingsReady())) {
    return { ok: false, reason: "ratings are not enabled on this database yet" };
  }
  const value = parseStars(stars);
  if (value == null) {
    return { ok: false, reason: "stars must be a whole number from 1 to 5" };
  }
  if (!doId || !dpId) {
    return { ok: false, reason: "a rating needs a delivery and a rider" };
  }

  await sequelize.query(
    `INSERT INTO \`store_delivery_ratings\`
       (\`do_id\`, \`dp_id\`, \`source_order_id\`, \`customer_id\`,
        \`stars\`, \`tags\`, \`comment\`, \`created_at\`)
     VALUES (:doId, :dpId, :sourceOrderId, :customerId,
             :stars, :tags, :comment, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE
       \`stars\` = VALUES(\`stars\`),
       \`tags\` = VALUES(\`tags\`),
       \`comment\` = VALUES(\`comment\`),
       \`updated_at\` = UTC_TIMESTAMP()`,
    {
      replacements: {
        doId,
        dpId,
        sourceOrderId: sourceOrderId ?? null,
        customerId: customerId ?? null,
        stars: value,
        tags: parseTags(tags),
        comment: parseComment(comment),
      },
      type: QueryTypes.INSERT,
    }
  );

  const { rating, count } = await recomputeRating(dpId);
  return { ok: true, stars: value, rating, count };
}

/** The rating already left for a delivery, or null. */
async function ratingForDelivery(doId) {
  if (!(await ratingsReady()) || !doId) return null;
  const [row] = await sequelize.query(
    "SELECT `stars`, `tags`, `comment` FROM `store_delivery_ratings` WHERE `do_id` = :doId",
    { replacements: { doId }, type: QueryTypes.SELECT }
  );
  if (!row) return null;
  return {
    stars: Number(row.stars),
    tags: row.tags ? String(row.tags).split(",") : [],
    comment: row.comment ?? null,
  };
}

/**
 * A rider's rating summary: the average, how many, and the real star spread.
 *
 * The spread replaces a fabricated one. The performance screen used to derive
 * its bars from the average with a formula — so a rider with ten 5s and a
 * rider with a mix averaging the same saw identical charts, and neither chart
 * described anything that had happened.
 */
async function summaryForPartner(dpId) {
  if (!(await ratingsReady())) return null;
  const rows = await sequelize.query(
    "SELECT `stars`, COUNT(*) n FROM `store_delivery_ratings` WHERE `dp_id` = :dpId GROUP BY `stars`",
    { replacements: { dpId }, type: QueryTypes.SELECT }
  );
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (const r of rows) {
    const s = Number(r.stars);
    const n = Number(r.n);
    if (counts[s] === undefined) continue;
    counts[s] = n;
    total += n;
    sum += s * n;
  }
  return {
    average: total ? Math.round((sum / total) * 100) / 100 : 0,
    count: total,
    breakdown: [5, 4, 3, 2, 1].map((star) => ({
      star,
      count: counts[star],
      pct: total ? Math.round((counts[star] / total) * 100) : 0,
    })),
  };
}

/** Recent ratings for a rider, newest first. Comments included. */
async function recentForPartner(dpId, { limit = 20 } = {}) {
  if (!(await ratingsReady())) return [];
  const capped = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await sequelize.query(
    `SELECT \`rating_id\`, \`stars\`, \`tags\`, \`comment\`, \`source_order_id\`, \`created_at\`
       FROM \`store_delivery_ratings\`
      WHERE \`dp_id\` = :dpId
      ORDER BY \`created_at\` DESC, \`rating_id\` DESC
      LIMIT ${capped}`,
    { replacements: { dpId }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({
    rating_id: r.rating_id,
    stars: Number(r.stars),
    tags: r.tags ? String(r.tags).split(",") : [],
    comment: r.comment ?? null,
    order_ref: r.source_order_id ?? null,
    created_at: r.created_at,
  }));
}

module.exports = {
  rateDelivery,
  ratingForDelivery,
  summaryForPartner,
  recentForPartner,
  recomputeRating,
  parseStars,
  parseTags,
  parseComment,
};
