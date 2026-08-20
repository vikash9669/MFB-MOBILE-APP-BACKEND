// Health endpoints.
//
// TWO ENDPOINTS, ON PURPOSE
//
//   GET /health        liveness — is this process alive? No database work, so
//                      it is cheap enough to call every couple of minutes
//                      forever. This is what a keep-alive pinger should hit.
//
//   GET /health/ready  readiness — can it actually serve? Pings the database
//                      and reports how far the schema is behind. Returns 503
//                      when it cannot, so a load balancer or an uptime monitor
//                      can tell "process running" from "process useful".
//
// Keeping them apart matters. If liveness did a database round trip, a brief
// database blip would look like a dead process and a platform would restart a
// perfectly healthy one — during exactly the incident when restarting is worst.
const sequelize = require("../util/database");
const { pending } = require("../util/schema");

const STARTED_AT = new Date();
const VERSION = (() => {
  try {
    return require("../package.json").version || "0.0.0";
  } catch {
    return "unknown";
  }
})();

const seconds = (n) => Math.round(n);

// GET /health — liveness. Always 200 while the process can answer.
exports.live = (req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: seconds(process.uptime()),
    started_at: STARTED_AT.toISOString(),
    now: new Date().toISOString(),
    version: VERSION,
    node: process.version,
  });
};

// The readiness result is cached briefly so that something hammering this
// endpoint cannot turn it into a database load generator. Two seconds is long
// enough to absorb a flood and short enough that a monitor polling every 30s
// always sees a fresh answer.
const CACHE_MS = 2000;
let cached = { at: 0, payload: null };

// GET /health/ready — readiness. 503 when the database is unreachable.
exports.ready = async (req, res) => {
  const now = Date.now();
  if (cached.payload && now - cached.at < CACHE_MS) {
    return res.status(cached.payload.status === "ok" ? 200 : 503).json(cached.payload);
  }

  const payload = {
    status: "ok",
    uptime_seconds: seconds(process.uptime()),
    version: VERSION,
    checks: {},
  };

  const startedDb = Date.now();
  try {
    await sequelize.query("SELECT 1");
    payload.checks.database = { ok: true, latency_ms: Date.now() - startedDb };
  } catch (err) {
    payload.status = "degraded";
    payload.checks.database = { ok: false, error: err.message.slice(0, 120) };
  }

  // Only meaningful if the database answered at all.
  if (payload.checks.database.ok) {
    try {
      const { missingTables, missingColumns } = await pending(sequelize);
      const behind = missingTables.length + missingColumns.length;
      payload.checks.schema = {
        ok: behind === 0,
        missing_tables: missingTables.length,
        missing_columns: missingColumns.length,
      };
      // A schema behind the code is not "down" — the readiness probe should not
      // pull a serving instance out of rotation for it — but it is worth
      // surfacing, because the features that depend on it are silently dormant.
      if (behind > 0) payload.status = "ok_schema_behind";
    } catch (err) {
      payload.checks.schema = { ok: false, error: err.message.slice(0, 120) };
    }
  }

  cached = { at: now, payload };
  res.status(payload.checks.database.ok ? 200 : 503).json(payload);
};
