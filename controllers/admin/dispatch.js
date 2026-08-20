// Admin control and observability for the dispatch engine.
//
// The brief asks for POST /dispatch/start, /reassign, /cancel and GET /status.
// They live under /admin/dispatch/* here so they inherit the panel's existing
// bearer auth and admin role guard rather than introducing a second auth scheme
// for one feature.
//
// The read endpoint matters more than the write ones. "Why did that rider get
// that order?" and "why is this order still unassigned?" are the two questions
// dispatch generates all day, and without the offer ledger and the log beside
// each other they are unanswerable after the fact.
const { QueryTypes } = require("sequelize");
const sequelize = require("../../util/database");
const { DeliveryOrder } = require("../../models");
const { dispatchReady } = require("../../util/dispatch/columns");
const { config } = require("../../util/dispatch/config");
const engine = require("../../util/dispatch/engine");
const { findCandidates } = require("../../util/dispatch/riderSearch");

const notReady = (res) =>
  res.status(503).json({
    message:
      "Dispatch engine is not enabled. Run migrations/2026-08-09-dispatch-engine.sql.",
  });

// GET /admin/dispatch/status — fleet + queue overview.
exports.status = async (req, res) => {
  try {
    if (!(await dispatchReady())) return notReady(res);

    const [queue] = await sequelize.query(
      `SELECT
         SUM(\`dispatch_state\` = 'waiting')   AS waiting,
         SUM(\`dispatch_state\` = 'searching') AS searching,
         SUM(\`dispatch_state\` = 'failed')    AS failed,
         SUM(\`status\` = 'accepted')          AS assigned,
         SUM(\`status\` = 'picked_up')         AS in_transit
       FROM \`store_delivery_orders\`
       WHERE \`status\` IN ('offered', 'accepted', 'picked_up')`,
      { type: QueryTypes.SELECT }
    );

    const [fleet] = await sequelize.query(
      `SELECT COUNT(*) AS total,
              SUM(\`dp_online\` = 1) AS online
         FROM \`store_delivery_partners\`
        WHERE \`dp_active\` = 1 AND \`dp_verification_status\` = 'approved'`,
      { type: QueryTypes.SELECT }
    );

    const [offers] = await sequelize.query(
      `SELECT
         SUM(\`state\` = 'pending')  AS live,
         SUM(\`state\` = 'accepted') AS accepted,
         SUM(\`state\` = 'rejected') AS rejected,
         SUM(\`state\` = 'expired')  AS expired
       FROM \`store_delivery_offers\`
       WHERE \`offered_at\` >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)`,
      { type: QueryTypes.SELECT }
    );

    const cfg = config();
    const offered = Number(offers.accepted || 0) + Number(offers.rejected || 0) + Number(offers.expired || 0);

    res.json({
      engine: { enabled: cfg.enabled, tickMs: cfg.tickMs },
      queue: {
        waiting: Number(queue.waiting || 0),
        searching: Number(queue.searching || 0),
        assigned: Number(queue.assigned || 0),
        in_transit: Number(queue.in_transit || 0),
        failed: Number(queue.failed || 0),
      },
      fleet: { approved: Number(fleet.total || 0), online: Number(fleet.online || 0) },
      offers_24h: {
        live: Number(offers.live || 0),
        accepted: Number(offers.accepted || 0),
        rejected: Number(offers.rejected || 0),
        expired: Number(offers.expired || 0),
        // The number that tells you whether the scorer is working: a low
        // acceptance rate means the engine keeps picking riders who say no.
        acceptance_pct: offered > 0 ? Math.round((Number(offers.accepted || 0) / offered) * 100) : null,
      },
      config: { weights: cfg.weights, radii: cfg.radii, offerTtlSec: cfg.offerTtlSec },
    });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch status ~ err:", err);
    res.status(500).json({ message: "Failed to load dispatch status" });
  }
};

// GET /admin/dispatch/jobs/:id — the full decision trail for one job.
exports.jobDetail = async (req, res) => {
  try {
    if (!(await dispatchReady())) return notReady(res);
    const doId = Number(req.params.id);

    const [job] = await sequelize.query(
      `SELECT \`do_id\`, \`source_order_id\`, \`order_ref\`, \`status\`, \`dp_id\`,
              \`dispatch_state\`, \`dispatch_at\`, \`search_radius_km\`, \`offer_round\`,
              \`dispatch_note\`, \`pickup_name\`, \`pickup_lat\`, \`pickup_lng\`,
              \`ready_in_min\`, \`earn_total\`
         FROM \`store_delivery_orders\` WHERE \`do_id\` = :doId`,
      { replacements: { doId }, type: QueryTypes.SELECT }
    );
    if (job == null) return res.status(404).json({ message: "Job not found" });

    const offers = await sequelize.query(
      `SELECT o.\`dp_id\`, p.\`dp_name\`, o.\`state\`, o.\`round\`, o.\`score\`,
              o.\`score_parts\`, o.\`distance_km\`, o.\`eta_min\`,
              o.\`offered_at\`, o.\`expires_at\`, o.\`responded_at\`
         FROM \`store_delivery_offers\` o
         LEFT JOIN \`store_delivery_partners\` p ON p.\`dp_id\` = o.\`dp_id\`
        WHERE o.\`do_id\` = :doId
        ORDER BY o.\`round\` ASC`,
      { replacements: { doId }, type: QueryTypes.SELECT }
    );

    const logs = await sequelize.query(
      `SELECT \`event\`, \`dp_id\`, \`radius_km\`, \`candidates\`, \`detail\`, \`created_at\`
         FROM \`store_dispatch_logs\` WHERE \`do_id\` = :doId
        ORDER BY \`log_id\` ASC LIMIT 100`,
      { replacements: { doId }, type: QueryTypes.SELECT }
    ).catch(() => []);

    res.json({ job, offers, logs });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch jobDetail ~ err:", err);
    res.status(500).json({ message: "Failed to load job" });
  }
};

// GET /admin/dispatch/jobs/:id/candidates — score the fleet, change nothing.
//
// This is the "why?" endpoint: it shows exactly who the engine would consider
// right now and how each one scores, without offering anything to anybody.
exports.candidates = async (req, res) => {
  try {
    if (!(await dispatchReady())) return notReady(res);

    const job = await DeliveryOrder.findByPk(req.params.id, { raw: true });
    if (job == null) return res.status(404).json({ message: "Job not found" });

    const { candidates, radiusKm, reason } = await findCandidates(job, { hasColumns: true });

    res.json({
      radius_km: radiusKm,
      reason: reason ?? null,
      candidates: candidates.slice(0, 20).map((c) => ({
        dp_id: c.rider.dpId,
        name: c.rider.name,
        score: c.score,
        distance_km: c.distanceKm,
        eta_min: c.etaMin,
        active_jobs: c.rider.activeJobs,
        parts: c.parts,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch candidates ~ err:", err);
    res.status(500).json({ message: "Failed to score candidates" });
  }
};

// POST /admin/dispatch/jobs/:id/start — dispatch this job now, ignoring timing.
exports.start = async (req, res) => {
  try {
    if (!(await dispatchReady())) return notReady(res);

    const [, changed] = await sequelize.query(
      `UPDATE \`store_delivery_orders\`
          SET \`dispatch_state\` = 'searching', \`dispatch_at\` = UTC_TIMESTAMP(),
              \`dispatch_note\` = 'started manually'
        WHERE \`do_id\` = :doId AND \`status\` = 'offered' AND \`dp_id\` IS NULL`,
      { replacements: { doId: req.params.id }, type: QueryTypes.UPDATE }
    );
    if (Number(changed ?? 0) === 0) {
      return res.status(409).json({ message: "Job is not waiting for a rider" });
    }

    const job = await DeliveryOrder.findByPk(req.params.id, { raw: true });
    const verdict = await engine.offerNext(job);
    res.json({ message: "Dispatch started", result: verdict ?? "no candidate yet" });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch start ~ err:", err);
    res.status(500).json({ message: "Failed to start dispatch" });
  }
};

// POST /admin/dispatch/jobs/:id/reassign — take it off the current rider.
exports.reassign = async (req, res) => {
  try {
    if (!(await dispatchReady())) return notReady(res);
    const result = await engine.reassign(
      Number(req.params.id),
      req.body?.reason || "reassigned by admin"
    );
    if (!result.ok) return res.status(409).json({ message: result.reason });
    res.json({ message: "Job returned to dispatch" });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch reassign ~ err:", err);
    res.status(500).json({ message: "Failed to reassign" });
  }
};

// POST /admin/dispatch/jobs/:id/cancel — stop trying to find a rider.
exports.cancel = async (req, res) => {
  try {
    if (!(await dispatchReady())) return notReady(res);

    const [, changed] = await sequelize.query(
      `UPDATE \`store_delivery_orders\`
          SET \`dispatch_state\` = 'cancelled', \`dispatch_note\` = :reason
        WHERE \`do_id\` = :doId AND \`status\` = 'offered'`,
      {
        replacements: {
          doId: req.params.id,
          reason: String(req.body?.reason || "cancelled by admin").slice(0, 255),
        },
        type: QueryTypes.UPDATE,
      }
    );
    if (Number(changed ?? 0) === 0) {
      return res.status(409).json({ message: "Job already has a rider" });
    }

    await sequelize.query(
      `UPDATE \`store_delivery_offers\` SET \`state\` = 'withdrawn'
        WHERE \`do_id\` = :doId AND \`state\` = 'pending'`,
      { replacements: { doId: req.params.id }, type: QueryTypes.UPDATE }
    );

    res.json({ message: "Dispatch cancelled" });
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch cancel ~ err:", err);
    res.status(500).json({ message: "Failed to cancel dispatch" });
  }
};
