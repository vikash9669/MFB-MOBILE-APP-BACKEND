const test = require("node:test");
const assert = require("node:assert");

// Three defects found while driving a real order through the deployed backend,
// all in the seam between an order's paperwork and its delivery job.
//
// No database: the models, the transaction and every side effect are stubbed,
// because what matters is only which calls each path makes.

const sequelize = require("../util/database");
const models = require("../models");
const orderLifecycle = require("../util/orderLifecycle");

// ── stubs shared by both controllers ──────────────────────────────────────
sequelize.transaction = async () => ({
  commit: async () => {},
  rollback: async () => {},
});

// controllers/admin/orders is destructured by portal.js at require time.
const adminOrders = require("../controllers/admin/orders");
adminOrders.logStatus = async () => {};
adminOrders.settleCashback = async () => {};

let retracted = [];
orderLifecycle.retractDeliveryJob = async (orderId, reason) => {
  retracted.push({ orderId, reason });
  return { retracted: true };
};

let orderRow = null;
models.StoreOrders.findOne = async () => orderRow;

let partnerUpdates = [];
let userRow = null;
models.User.findByPk = async () => userRow;
models.DeliveryPartner.update = async (fields, opts) => {
  partnerUpdates.push({ fields, where: opts.where });
  return [1];
};

delete require.cache[require.resolve("../controllers/admin/portal")];
delete require.cache[require.resolve("../controllers/admin/people")];
const portal = require("../controllers/admin/portal");
const people = require("../controllers/admin/people");

function fakeRes() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const fakeOrder = (id, status) => ({
  order_id: id,
  order_status: status,
  order_delivered_time: null,
  async update() {},
});

test.beforeEach(() => {
  retracted = [];
  partnerUpdates = [];
  orderRow = null;
  userRow = null;
});

// ── 1. cancelling from the panel must retract the delivery job ────────────
//
// Reproduced on the clone: two orders cancelled through this endpoint left
// their jobs at 'offered' and still in the dispatch queue. The engine kept
// searching, and a rider could have been offered — and accepted — an order
// that was already cancelled.

test("cancelling an order retracts its delivery job", async () => {
  orderRow = fakeOrder(276511, 1);
  const res = fakeRes();
  await portal.updateStatus(
    { params: { id: 276511 }, body: { status: 6 }, panel: { portal: "admin", user_id: 1 } },
    res
  );

  assert.strictEqual(res.code, 200, "the cancellation itself must still succeed");
  assert.strictEqual(retracted.length, 1, "the delivery job must be retracted");
  assert.strictEqual(retracted[0].orderId, 276511);
});

test("a status change that is not a cancellation retracts nothing", async () => {
  // Guards the obvious over-correction: retracting on every status write would
  // pull the job out from under a rider the moment a vendor marked it ready.
  for (const status of [0, 1, 2, 4, 5]) {
    retracted = [];
    orderRow = fakeOrder(276511, 0);
    await portal.updateStatus(
      { params: { id: 276511 }, body: { status }, panel: { portal: "admin", user_id: 1 } },
      fakeRes()
    );
    assert.strictEqual(retracted.length, 0, `status ${status} must not retract`);
  }
});

test("a failing retraction does not fail the cancellation", async () => {
  // The row is already committed by then. Reporting the cancel as failed would
  // invite the operator to press it again.
  orderLifecycle.retractDeliveryJob = async () => {
    throw new Error("dispatch tables missing");
  };
  orderRow = fakeOrder(276511, 1);
  const res = fakeRes();
  await portal.updateStatus(
    { params: { id: 276511 }, body: { status: 6 }, panel: { portal: "admin", user_id: 1 } },
    res
  );
  assert.strictEqual(res.code, 200);
  orderLifecycle.retractDeliveryJob = async (orderId, reason) => {
    retracted.push({ orderId, reason });
  };
});

// ── 2. listing a rider must make them visible to dispatch ─────────────────
//
// dispatch reads dp_active and nothing an operator could click ever wrote it,
// so an approved, Listed, online rider could still be invisible to the engine.

test("listing a rider sets dp_active as well as user_active", async () => {
  userRow = { user_id: 19777, user_role: 3, async update() {} };
  const res = fakeRes();
  await people.setActive({ params: { id: 19777 }, body: { active: 1 } }, res);

  assert.strictEqual(res.code, 200);
  assert.strictEqual(partnerUpdates.length, 1, "the rider's dispatch flag must be written");
  assert.strictEqual(partnerUpdates[0].fields.dp_active, 1);
  assert.strictEqual(partnerUpdates[0].where.dp_id, 19777);
  assert.strictEqual(res.body.dispatchable, true, "the panel needs to be able to say so");
});

test("delisting a rider clears dp_active", async () => {
  userRow = { user_id: 19777, user_role: 3, async update() {} };
  const res = fakeRes();
  await people.setActive({ params: { id: 19777 }, body: { active: 0 } }, res);

  assert.strictEqual(partnerUpdates[0].fields.dp_active, 0);
  assert.strictEqual(res.body.dispatchable, false);
});

test("listing a customer or vendor touches no delivery flags", async () => {
  for (const role of [4, 12, 0]) {
    partnerUpdates = [];
    userRow = { user_id: 500, user_role: role, async update() {} };
    const res = fakeRes();
    await people.setActive({ params: { id: 500 }, body: { active: 1 } }, res);
    assert.strictEqual(partnerUpdates.length, 0, `role ${role} must not get rider columns`);
    assert.strictEqual(res.body.dispatchable, null);
  }
});

// ── 3. offered_at must be written in the same clock as everything else ────

test("a new delivery job takes offered_at from MySQL, not from a JS Date", () => {
  // A JS Date is serialised in the connection timezone (+05:30) while every
  // other timestamp on this table is UTC_TIMESTAMP(), so the same row reported
  // `offered_at: 12:19Z` beside `dispatch_at: 06:49Z` — the same instant, 5h30m
  // apart. Asserted on the source because the bug is in which expression is
  // emitted, and the INSERT itself needs a database to observe.
  const src = require("node:fs").readFileSync(
    require.resolve("../util/deliveryDispatch"),
    "utf8"
  );
  assert.match(
    src,
    /offered_at:\s*fn\("UTC_TIMESTAMP"\)/,
    "offered_at must be computed by MySQL"
  );
  assert.doesNotMatch(
    src,
    /offered_at:\s*new Date\(\)/,
    "a JS Date here writes IST wall clock into a UTC column"
  );
});

test("fn(UTC_TIMESTAMP) really emits SQL rather than a bound parameter", () => {
  // The whole fix rests on this: if Sequelize bound it as a parameter instead,
  // the value would go back through the timezone-aware formatter and nothing
  // would have changed.
  const { Sequelize, DataTypes, fn } = require("sequelize");
  const s = new Sequelize("db", "u", "p", {
    dialect: "mysql",
    logging: false,
    timezone: "+05:30",
  });
  const M = s.define("t", { offered_at: { type: DataTypes.DATE } }, {
    tableName: "t",
    timestamps: false,
  });
  const qg = s.getQueryInterface().queryGenerator;
  const { query } = qg.insertQuery("t", { offered_at: fn("UTC_TIMESTAMP") }, M.rawAttributes, {});
  assert.match(query, /VALUES \(UTC_TIMESTAMP\(\)\)/);
});
