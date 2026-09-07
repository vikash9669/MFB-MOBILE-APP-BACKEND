const { test } = require("node:test");
const assert = require("node:assert");

// Broadcast mode is the new default; pin the levers so a stray env can't move
// them under the test.
process.env.DISPATCH_MODE = "broadcast";
delete process.env.DISPATCH_BROADCAST_RADIUS_KM;
delete process.env.DISPATCH_BROADCAST_TTL_SEC;
delete process.env.DISPATCH_ADMIN_ESCALATE_MIN;

const { config } = require("../util/dispatch/config");
const offers = require("../util/dispatch/offers");
// The offers module and this test must share ONE connection object for the stub
// to land on the function offers actually calls.
const sequelize = require("../util/database");

test("broadcast reaches the whole fleet, on a 2-min / 4-min cadence", () => {
  const cfg = config();
  assert.strictEqual(cfg.mode, "broadcast");
  assert.strictEqual(cfg.broadcastTtlSec, 120);
  assert.strictEqual(cfg.adminEscalateMin, 4);
  // There is no radius any more. A broadcast that still had one would quietly
  // reintroduce the exclusion this change removed — a rider with no location
  // fix, or one outside the ring, never hearing about the job at all.
  assert.ok(!("broadcastRadiusKm" in cfg), "broadcast must not be bounded by distance");
});

test("createBroadcastOffers emits one row per rider and re-arms via ON DUPLICATE KEY", async () => {
  const realQuery = sequelize.query;
  const calls = [];
  sequelize.query = async (sql, opts) => {
    calls.push({ sql, opts });
    return [];
  };

  const job = { do_id: 77, earn_total: 42 };
  // Shape matches eligibleRiders(): dpId/distanceKm at the top level, no `.rider`
  // wrapper. (An earlier version of this test wrapped them in `.rider`, which is
  // findCandidates' shape — and it hid a real bug the integration test caught.)
  const candidates = [
    { dpId: 11, distanceKm: 1.2, etaMin: 4 },
    { dpId: 22, distanceKm: 3.4, etaMin: 9 },
    { dpId: 33, distanceKm: 6.0, etaMin: 15 },
  ];

  try {
    const n = await offers.createBroadcastOffers(job, candidates, 2, 120);
    assert.strictEqual(n, 3, "should report one live offer per candidate");

    const insert = calls.find(
      (c) => /INSERT INTO `store_delivery_offers`/.test(c.sql) && /VALUES/.test(c.sql)
    );
    assert.ok(insert, "an INSERT into the offers table should have run");
    assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/, "must re-arm, not collide on the unique key");

    // One value tuple per rider (each tuple ends with the expires_at INTERVAL),
    // and every rider id passed as a replacement — no more, no fewer.
    assert.strictEqual((insert.sql.match(/INTERVAL :ttl SECOND\)/g) || []).length, 3);
    assert.strictEqual(insert.opts.replacements.dp0, 11);
    assert.strictEqual(insert.opts.replacements.dp1, 22);
    assert.strictEqual(insert.opts.replacements.dp2, 33);
    assert.strictEqual(insert.opts.replacements.dp3, undefined);
    assert.strictEqual(insert.opts.replacements.doId, 77);
    assert.strictEqual(insert.opts.replacements.round, 2);
    assert.strictEqual(insert.opts.replacements.ttl, 120);
  } finally {
    sequelize.query = realQuery;
  }
});

test("createBroadcastOffers with nobody in range does nothing and touches no DB", async () => {
  const realQuery = sequelize.query;
  let touched = false;
  sequelize.query = async () => {
    touched = true;
    return [];
  };
  try {
    const n = await offers.createBroadcastOffers({ do_id: 1 }, [], 1, 120);
    assert.strictEqual(n, 0);
    assert.strictEqual(touched, false, "no candidates must mean no query at all");
  } finally {
    sequelize.query = realQuery;
  }
});
