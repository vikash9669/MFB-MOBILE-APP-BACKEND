const test = require("node:test");
const assert = require("node:assert");

// Cancelling an order must take its delivery job out of the rider pool.
//
// Before this, cancelOrder only touched store_orders. A job is queued the
// moment an order is placed, so a declined or auto-cancelled order left a live
// `offered` row that a rider could still claim — riding to a restaurant for an
// order that had already been refunded.
//
// No database: sequelize.query is stubbed, which is enough because what matters
// is WHICH statuses the UPDATE touches and WHO gets told.

const sequelize = require("../util/database");
const deliveryNotify = require("../util/deliveryNotify");

let queries = [];
let selectRows = [];
let updateCount = 0;
let notified = [];
let failNext = null;

sequelize.query = async (sql, opts) => {
  queries.push({ sql: String(sql).replace(/\s+/g, " ").trim(), opts });
  if (failNext) { const e = failNext; failNext = null; throw new Error(e); }
  if (/^SELECT/i.test(String(sql).trim())) return selectRows;
  return [undefined, updateCount];
};
deliveryNotify.notifyPartner = async (dpId, msg) => { notified.push({ dpId, msg }); };

delete require.cache[require.resolve("../util/orderLifecycle")];
const { retractDeliveryJob } = require("../util/orderLifecycle");

test.beforeEach(() => { queries = []; selectRows = []; updateCount = 0; notified = []; failNext = null; });

test("only offered and accepted jobs are retracted", async () => {
  selectRows = [{ do_id: 7, dp_id: null, status: "offered" }];
  updateCount = 1;
  await retractDeliveryJob(276444, "vendor declined");

  const select = queries.find((q) => /^SELECT/i.test(q.sql));
  const update = queries.find((q) => /^UPDATE/i.test(q.sql));

  for (const q of [select, update]) {
    assert.match(q.sql, /'offered', 'accepted'/, "must scope to these two states");
    assert.doesNotMatch(q.sql, /picked_up/, "food already collected must not be retracted");
    assert.doesNotMatch(q.sql, /delivered/, "a completed delivery must not be retracted");
  }
  assert.match(update.sql, /SET `status` = 'cancelled'/);
  assert.equal(update.opts.replacements.orderId, 276444);
});

test("a rider who had already claimed the job is told", async () => {
  selectRows = [{ do_id: 9, dp_id: 4242, status: "accepted" }];
  updateCount = 1;
  await retractDeliveryJob(500, "restaurant closed");

  assert.equal(notified.length, 1);
  assert.equal(notified[0].dpId, 4242);
  assert.match(notified[0].msg.body, /cancelled/i);
  assert.match(notified[0].msg.body, /restaurant closed/);
  assert.equal(notified[0].msg.data.do_id, "9");
});

test("an unclaimed offer notifies nobody", async () => {
  selectRows = [{ do_id: 10, dp_id: null, status: "offered" }];
  updateCount = 1;
  await retractDeliveryJob(501, "timed out");
  assert.equal(notified.length, 0, "there is no rider to tell");
});

test("no job to retract does no work and reports zero", async () => {
  selectRows = [];
  const r = await retractDeliveryJob(502, "declined");
  assert.deepEqual(r, { retracted: 0 });
  assert.equal(queries.filter((q) => /^UPDATE/i.test(q.sql)).length, 0, "no pointless UPDATE");
});

test("a database failure never throws — the cancellation must still stand", async () => {
  failNext = "connection lost";
  const r = await retractDeliveryJob(503, "declined");
  assert.equal(r.retracted, 0);
  assert.match(r.error, /connection lost/);
});

test("a failing rider push does not break the retraction", async () => {
  selectRows = [{ do_id: 11, dp_id: 77, status: "accepted" }];
  updateCount = 1;
  deliveryNotify.notifyPartner = async () => { throw new Error("fcm down"); };
  delete require.cache[require.resolve("../util/orderLifecycle")];
  const { retractDeliveryJob: fresh } = require("../util/orderLifecycle");
  const r = await fresh(504, "declined");
  assert.equal(r.retracted, 1, "the job is still retracted even if the push fails");
});
