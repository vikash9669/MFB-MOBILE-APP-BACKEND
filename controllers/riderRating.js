// The customer rating their delivery partner.
//
// One endpoint, deliberately narrow: a rating is only ever about a delivery the
// caller actually received. Every guard here exists because dp_rating feeds
// dispatch scoring — a rating anyone could post for any rider would be a way to
// push a competitor down the ranking, not just a cosmetic star.
const { QueryTypes } = require("sequelize");
const sequelize = require("../util/database");
const { ratingsReady } = require("../util/ratingColumns");
const { rateDelivery, ratingForDelivery } = require("../util/ratings");

/**
 * How long after delivery a customer may still rate.
 *
 * Not unlimited: a rating arriving weeks later says more about the customer's
 * memory than the rider's work, and an open-ended window is an open-ended way
 * to alter a rider's score. Generous enough to cover "I'll do it tomorrow".
 */
const WINDOW_HOURS = Number(process.env.RATING_WINDOW_HOURS || 72);

/**
 * The delivery being rated, if it belongs to this customer and is rateable.
 *
 * Joins through store_orders rather than trusting a customer_id on the delivery
 * job: the order is where ownership actually lives.
 */
async function rateableJob(orderId, customerId) {
  const [row] = await sequelize.query(
    `SELECT d.\`do_id\`, d.\`dp_id\`, d.\`status\`, d.\`delivered_at\`, o.\`customer_id\`
       FROM \`store_delivery_orders\` d
       JOIN \`store_orders\` o ON o.\`order_id\` = d.\`source_order_id\`
      WHERE d.\`source_order_id\` = :orderId`,
    { replacements: { orderId }, type: QueryTypes.SELECT }
  );
  if (!row) return { error: "No delivery found for this order" };
  if (Number(row.customer_id) !== Number(customerId)) {
    // Deliberately the same message as "not found": telling a stranger that an
    // order exists but is not theirs is more than they need to know.
    return { error: "No delivery found for this order" };
  }
  if (row.status !== "delivered") {
    return { error: "You can rate your delivery once it has arrived" };
  }
  if (row.dp_id == null) {
    return { error: "This delivery has no rider to rate" };
  }
  if (row.delivered_at) {
    const ageH = (Date.now() - new Date(row.delivered_at).getTime()) / 3600000;
    if (ageH > WINDOW_HOURS) {
      return { error: `Ratings close ${WINDOW_HOURS} hours after delivery` };
    }
  }
  return { job: row };
}

// POST /user/orders/:orderId/rate   { stars, tags?, comment? }
exports.rate = async (req, res) => {
  try {
    if (!(await ratingsReady())) {
      return res.status(503).json({ message: "Ratings are not available yet" });
    }
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ message: "Invalid order" });
    }

    const { job, error } = await rateableJob(orderId, req.user.user_id);
    if (error) return res.status(404).json({ message: error });

    const result = await rateDelivery({
      doId: job.do_id,
      dpId: job.dp_id,
      sourceOrderId: orderId,
      customerId: req.user.user_id,
      stars: req.body?.stars,
      tags: req.body?.tags,
      comment: req.body?.comment,
    });

    if (!result.ok) return res.status(422).json({ message: result.reason });

    res.json({
      message: "Thanks for the feedback",
      stars: result.stars,
      // The rider's new average, so the client can show it without a refetch.
      rider_rating: result.rating,
      rider_rating_count: result.count,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ rate rider ~ err:", err);
    res.status(500).json({ message: "Could not save your rating" });
  }
};

// GET /user/orders/:orderId/rate — what this customer already said, if anything.
exports.get = async (req, res) => {
  try {
    if (!(await ratingsReady())) return res.json({ rating: null });
    const orderId = Number(req.params.orderId);
    const { job, error } = await rateableJob(orderId, req.user.user_id);
    if (error) return res.json({ rating: null, reason: error });
    res.json({ rating: await ratingForDelivery(job.do_id), do_id: job.do_id });
  } catch (err) {
    console.log("MFB-error-logs ~ get rating ~ err:", err);
    res.status(500).json({ message: "Could not load your rating" });
  }
};
