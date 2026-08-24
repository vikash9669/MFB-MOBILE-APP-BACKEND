const test = require("node:test");
const assert = require("node:assert");

// Recovering live orders that never reached the rider pool.
//
// queueDeliveryJob runs once, at placement, and swallows its errors so a
// dispatch problem cannot fail an already-paid order. The consequence is that a
// transient failure leaves an order no rider will ever see, with nothing
// retrying. This sweeper is the retry.

const sequelize = require("../util/database");
const dispatch = require("../util/deliveryDispatch");

let queries = [];
let rows = [];
let created = [];
let behaviour = {};   // order_id -> "ok" | "null" | "throw"

sequelize.query = async (sql, opts) => {
  queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), opts });
  return rows;
};
dispatch.createJobForOrder = async (orderId) => {
  const how = behaviour[orderId] ?? "ok";
  if (how === "throw") throw new Error("geocode timeout");
  if (how === "null") return null;
  created.push(orderId);
  return { do_id: 900 + orderId };
};

delete require.cache[require.resolve("../util/orphanJobSweeper")];
const sweeper = require("../util/orphanJobSweeper");
const { sweepOrphanJobs, MAX_ATTEMPTS } = sweeper;

test.beforeEach(() => {
  queries = []; rows = []; created = []; behaviour = {};
  sweeper._attempts.clear();
});

// ── what it looks for ──────────────────────────────────────────────────────

test("only live orders are considered, and only recent ones", async () => {
  await sweepOrphanJobs();
  const sql = queries[0].sql;
  assert.match(sql, /`order_status` IN \(0, 1\)/, "cancelled and delivered are out of scope");
  assert.match(sql, /NOT EXISTS/, "must skip orders that already have a job");
  assert.match(sql, /`source_order_id` = o\.`order_id`/);
  assert.match(sql, /LIMIT :batch/, "a backlog must not become one huge query");
});

test("the window compares against NOW(), not UTC_TIMESTAMP()", async () => {
  await sweepOrphanJobs();
  const sql = queries[0].sql;
  // order_received_time is written in the +05:30 session timezone. Comparing it
  // to UTC would make every row look 5.5h younger and silently widen the window.
  assert.match(sql, /DATE_SUB\(NOW\(\), INTERVAL :mins MINUTE\)/);
  assert.doesNotMatch(sql, /UTC_TIMESTAMP/);
});

// ── what it does ───────────────────────────────────────────────────────────

test("an orphaned order is queued", async () => {
  rows = [{ order_id: 276445 }];
  const r = await sweepOrphanJobs();
  assert.deepEqual(r, { found: 1, queued: 1, gaveUp: 0 });
  assert.deepEqual(created, [276445]);
});

test("nothing to do is not an error", async () => {
  rows = [];
  assert.deepEqual(await sweepOrphanJobs(), { found: 0, queued: 0, gaveUp: 0 });
  assert.equal(created.length, 0);
});

test("one failing order does not stop the others", async () => {
  rows = [{ order_id: 1 }, { order_id: 2 }, { order_id: 3 }];
  behaviour[2] = "throw";
  const r = await sweepOrphanJobs();
  assert.deepEqual(r, { found: 3, queued: 2, gaveUp: 0 });
  assert.deepEqual(created, [1, 3]);
});

// ── not spinning for ever ──────────────────────────────────────────────────

test("a permanently failing order is abandoned after MAX_ATTEMPTS", async () => {
  rows = [{ order_id: 7 }];
  behaviour[7] = "throw";

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const r = await sweepOrphanJobs();
    assert.equal(r.gaveUp, 0, `attempt ${i + 1} should still be trying`);
  }
  // Next pass sees it as given up and stops calling dispatch.
  const after = await sweepOrphanJobs();
  assert.equal(after.gaveUp, 1);
  assert.equal(after.queued, 0);
});

test("giving up on one order does not affect another", async () => {
  rows = [{ order_id: 7 }];
  behaviour[7] = "throw";
  for (let i = 0; i <= MAX_ATTEMPTS; i += 1) await sweepOrphanJobs();

  rows = [{ order_id: 7 }, { order_id: 8 }];
  const r = await sweepOrphanJobs();
  assert.equal(r.gaveUp, 1);
  assert.equal(r.queued, 1);
  assert.ok(created.includes(8));
});

test("a success resets the attempt counter", async () => {
  rows = [{ order_id: 9 }];
  behaviour[9] = "throw";
  await sweepOrphanJobs();
  await sweepOrphanJobs();
  assert.equal(sweeper._attempts.get(9), 2);

  behaviour[9] = "ok";
  await sweepOrphanJobs();
  assert.equal(sweeper._attempts.has(9), false, "a recovered order starts clean");
});

test("a null job counts as an attempt rather than looping for ever", async () => {
  rows = [{ order_id: 11 }];
  behaviour[11] = "null";
  await sweepOrphanJobs();
  assert.equal(sweeper._attempts.get(11), 1);
  assert.equal(created.length, 0);
});

test("createJobForOrder being idempotent means a race cannot double-queue", async () => {
  // The real implementation returns the existing row; the sweeper must simply
  // accept whatever it is handed and not create a second job itself.
  rows = [{ order_id: 12 }];
  await sweepOrphanJobs();
  await sweepOrphanJobs();
  assert.deepEqual(created, [12, 12], "two calls, and dispatch decides — never two rows here");
  assert.equal(queries.filter((q) => /^INSERT/i.test(q.sql)).length, 0);
});
