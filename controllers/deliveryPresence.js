// Rider presence over HTTP — the fallback for util/presence/socket.js, and the
// read the app uses to show today's online time.
const { QueryTypes } = require("sequelize");
const sequelize = require("../util/database");
const { ingestSamples } = require("../util/presence/ingest");
const { accruedToday } = require("../util/presence/onlinePay");
const { presenceConfig } = require("../util/presence/config");

// POST /delivery/presence/samples  { client_now, samples: [...] }
// Same contract as a socket "samples" frame: the phone may delete everything up
// to ack_seq, and nothing if the request fails.
exports.uploadSamples = async (req, res) => {
  try {
    const result = await ingestSamples(req.user.dp_id, req.body?.samples, {
      clientNowMs: req.body?.client_now,
    });
    res.json({ ack_seq: result.ackSeq, accepted: result.accepted, rejected: result.rejected });
  } catch (err) {
    console.log("MFB-error-logs ~ presence upload ~ err:", err);
    // 503, not 500: nothing is wrong with the samples; try again.
    res.status(503).json({ message: "Samples not stored, please resend" });
  }
};

// GET /delivery/presence/today — online now, minutes today, pay so far.
exports.today = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const cfg = presenceConfig();
    const now = Date.now();
    const [last] = await sequelize.query(
      "SELECT `end_ms`, `end_reason` FROM `store_rider_presence_spans` WHERE `dp_id` = :dpId AND (`end_reason` IS NULL OR `end_reason` <> 'blackout') ORDER BY `end_ms` DESC LIMIT 1",
      { replacements: { dpId }, type: QueryTypes.SELECT }
    );
    const lastMs = last ? Number(last.end_ms) : null;
    const accrued = await accruedToday(dpId, { nowMs: now });
    res.json({
      // Online by the same rule pay uses: a fix within the gap, not ended by a
      // go-offline tap.
      online_now: lastMs != null && now - lastMs <= cfg.gapMs && last.end_reason !== "offline",
      last_fix_at: lastMs ? new Date(lastMs).toISOString() : null,
      gap_min: cfg.gapMs / 60_000,
      ...accrued,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ presence today ~ err:", err);
    res.status(500).json({ message: "Failed to load online time" });
  }
};
