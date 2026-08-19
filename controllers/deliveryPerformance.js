const { DeliveryPartner } = require("../models");
const { num } = require("../util/delivery");
const { summaryForPartner, recentForPartner } = require("../util/ratings");

// GET /delivery/performance?period=week|month|all
// Metrics are stored as rolling values on the partner row; the period is echoed
// back so the UI segmented control stays in sync.
exports.getPerformance = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    const period = ["week", "month", "all"].includes(req.query.period)
      ? req.query.period
      : "week";

    // Real ratings when the table exists.
    //
    // What was here before invented the star spread: it ran a formula over the
    // average and emitted three bars. Two riders with identical averages but
    // completely different histories — one steady 4s, one alternating 5s and
    // 2s — saw the same chart, and neither chart described anything a customer
    // had actually done. A rider looking at it to work out what to improve was
    // reading arithmetic on a single number.
    const summary = await summaryForPartner(req.user.dp_id);

    // Falls back to the cached column when the migration has not run, so the
    // screen keeps working — just without a breakdown, which is honest: with no
    // ratings table there is no breakdown to show.
    const rating = summary ? summary.average : num(partner.dp_rating);

    res.json({
      period,
      acceptance_pct: num(partner.dp_acceptance_pct),
      completion_pct: num(partner.dp_completion_pct),
      cancellation_pct: num(partner.dp_cancellation_pct),
      avg_delivery_min: num(partner.dp_avg_delivery_min),
      rating,
      rating_count: summary ? summary.count : 0,
      total_deliveries: num(partner.dp_total_deliveries),
      // Every star, not just the top three — a rider needs to see the 1s and 2s
      // most of all. Empty when there is nothing real to show.
      rating_breakdown: summary ? summary.breakdown : [],
      recent_ratings: await recentForPartner(req.user.dp_id, { limit: 10 }),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getPerformance ~ err:", err);
    res.status(500).json({ message: "Failed to load performance", err });
  }
};
