const { DeliveryPartner } = require("../models");
const { num } = require("../util/delivery");

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

    const rating = num(partner.dp_rating);
    // Approximate a star distribution from the average rating for the UI bars.
    const five = Math.min(0.95, Math.max(0.5, (rating - 3) / 2));
    const four = Math.min(0.3, (1 - five) * 0.7);
    const three = Math.max(0, 1 - five - four);

    res.json({
      period,
      acceptance_pct: num(partner.dp_acceptance_pct),
      completion_pct: num(partner.dp_completion_pct),
      cancellation_pct: num(partner.dp_cancellation_pct),
      avg_delivery_min: num(partner.dp_avg_delivery_min),
      rating,
      total_deliveries: num(partner.dp_total_deliveries),
      rating_breakdown: [
        { star: 5, pct: Math.round(five * 100) },
        { star: 4, pct: Math.round(four * 100) },
        { star: 3, pct: Math.round(three * 100) },
      ],
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getPerformance ~ err:", err);
    res.status(500).json({ message: "Failed to load performance", err });
  }
};
