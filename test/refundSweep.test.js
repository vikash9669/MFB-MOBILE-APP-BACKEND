const test = require("node:test");
const assert = require("node:assert");

// Chasing refunds we started and never heard back about.
//
// refundPayment records PENDING and returns, because every gateway settles
// refunds asynchronously. Nothing polled after that, so a refund the gateway
// later REJECTED was indistinguishable from one still in flight: the row said
// PENDING for ever and the customer simply never got their money.

const sequelize = require("../util/database");
const lifecycleColumns = require("../util/lifecycleColumns");
const gateway = require("../util/gateway");
const adminNotify = require("../util/adminNotify");

let queries = [];
let rows = [];
let statuses = {};
let alerts = [];
let ready = true;
let throwFor = null;

sequelize.query = async (sql, opts) => {
  const flat = String(sql).replace(/\s+/g, " ").trim();
  queries.push({ sql: flat, opts });
  if (/^SELECT/i.test(flat)) return rows;
  return [undefined, 1];
};
lifecycleColumns.refundsReady = async () => ready;
gateway.fetchRefundStatus = async ({ merchantRefundId }) => {
  if (throwFor === merchantRefundId) throw new Error("gateway timeout");
  return statuses[merchantRefundId] ?? { completed: false, failed: false, state: "PENDING", message: "PENDING" };
};
adminNotify.notifyAdminsRefundFailed = async (a) => { alerts.push(a); return {}; };

delete require.cache[require.resolve("../util/paymentSweeper")];
const { reconcileRefunds } = require("../util/paymentSweeper");

const row = (over = {}) => ({
  pi_id: 8, merchant_txn_id: "MFB1", merchant_refund_id: "RFB8",
  order_id: 276444, refund_amount: "25.00", ...over,
});

test.beforeEach(() => { queries = []; rows = []; statuses = {}; alerts = []; ready = true; throwFor = null; });

test("a completed refund is stamped COMPLETED with a timestamp", async () => {
  rows = [row()];
  statuses.RFB8 = { completed: true, failed: false, state: "SUCCESS", message: "SUCCESS" };

  const r = await reconcileRefunds();
  assert.deepEqual(r, { checked: 1, settled: 1, failed: 0 });

  const upd = queries.find((q) => /^UPDATE/i.test(q.sql));
  assert.match(upd.sql, /`refund_status` = 'COMPLETED'/);
  assert.match(upd.sql, /`refunded_at` = UTC_TIMESTAMP\(\)/);
  assert.match(upd.sql, /`refund_status` = 'PENDING'/, "guarded so a race cannot double-write");
  assert.equal(alerts.length, 0);
});

test("a rejected refund is recorded FAILED and reaches a human", async () => {
  rows = [row()];
  statuses.RFB8 = { completed: false, failed: true, state: "FAILED", message: "account closed" };

  const r = await reconcileRefunds();
  assert.deepEqual(r, { checked: 1, settled: 0, failed: 1 });

  const upd = queries.find((q) => /^UPDATE/i.test(q.sql));
  assert.match(upd.sql, /`refund_status` = 'FAILED'/);
  assert.equal(upd.opts.replacements.reason, "account closed");

  assert.equal(alerts.length, 1, "the customer is still out of pocket — somebody must know");
  assert.equal(alerts[0].orderId, 276444);
  assert.equal(alerts[0].amount, "25.00");
  assert.match(alerts[0].reason, /account closed/);
});

test("a refund still in flight is left completely alone", async () => {
  rows = [row()];
  statuses.RFB8 = { completed: false, failed: false, state: "PENDING", message: "PENDING" };

  const r = await reconcileRefunds();
  assert.deepEqual(r, { checked: 1, settled: 0, failed: 0 });
  assert.equal(queries.filter((q) => /^UPDATE/i.test(q.sql)).length, 0);
  assert.equal(alerts.length, 0);
});

test("ONHOLD is in flight, not a failure", async () => {
  rows = [row()];
  statuses.RFB8 = { completed: false, failed: false, state: "ONHOLD", message: "ONHOLD" };
  const r = await reconcileRefunds();
  assert.equal(r.failed, 0, "ONHOLD must not be written off as failed");
});

test("a gateway error leaves the row PENDING for the next tick", async () => {
  rows = [row()];
  throwFor = "RFB8";
  const r = await reconcileRefunds();
  assert.deepEqual(r, { checked: 1, settled: 0, failed: 0 });
  assert.equal(queries.filter((q) => /^UPDATE/i.test(q.sql)).length, 0, "transient must not be recorded as final");
});

test("only PENDING refunds with an id are selected", async () => {
  rows = [];
  await reconcileRefunds();
  const sel = queries.find((q) => /^SELECT/i.test(q.sql));
  assert.match(sel.sql, /`merchant_refund_id` IS NOT NULL/);
  assert.match(sel.sql, /`refund_status` = 'PENDING'/);
  assert.match(sel.sql, /LIMIT :batch/, "a backlog must not become one huge query");
});

test("it does nothing at all before the refund columns exist", async () => {
  ready = false;
  rows = [row()];
  const r = await reconcileRefunds();
  assert.deepEqual(r, { checked: 0, settled: 0, failed: 0 });
  assert.equal(queries.length, 0, "must not touch a table whose columns are missing");
});

test("a batch is processed one row at a time, and one bad row does not stop the rest", async () => {
  rows = [row({ pi_id: 1, merchant_refund_id: "RFB1" }),
          row({ pi_id: 2, merchant_refund_id: "RFB2" }),
          row({ pi_id: 3, merchant_refund_id: "RFB3" })];
  throwFor = "RFB2";
  statuses.RFB1 = { completed: true, failed: false, state: "SUCCESS", message: "" };
  statuses.RFB3 = { completed: false, failed: true, state: "FAILED", message: "declined" };

  const r = await reconcileRefunds();
  assert.deepEqual(r, { checked: 3, settled: 1, failed: 1 });
  assert.equal(alerts.length, 1);
});
