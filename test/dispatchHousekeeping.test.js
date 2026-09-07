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

// ── 3. an offer deadline must cross the wire as a duration ───────────────
//
// The connection timezone is +05:30. A column written with UTC_TIMESTAMP()
// holds true UTC, but the driver reads it back as though it were IST, so the
// value reaches JS 5h30m early. Inside SQL those columns only ever meet each
// other, so dispatch timing is right — the skew appears only on the way out.
//
// Handing that value to a phone is what broke the delivery call: the rider app
// parsed expires_at, compared it against its own correct clock, decided the
// offer had lapsed hours ago, dismissed the ringing notification and navigated
// back. The offer was pending on the server the whole time. Observed live.

const { deadlineFor } = require("../util/dispatch/offers");

test("a deadline is rebuilt on this process's clock, not the database's", () => {
  const now = Date.UTC(2026, 8, 7, 12, 36, 0);
  // What the database reports: 120 seconds left. Its absolute expires_at is
  // hours away from `now` and is deliberately ignored.
  const at = deadlineFor({ expires_in_sec: 120, expires_at: "2026-09-07T07:08:12.000Z" }, { now });
  assert.strictEqual(at, new Date(now + 120_000).toISOString());
});

test("an offer with no time left yields no deadline rather than a past one", () => {
  // A deadline already behind the client's clock is exactly what made the app
  // throw good offers away, so never emit one.
  for (const secs of [0, -1, -19800]) {
    assert.strictEqual(deadlineFor({ expires_in_sec: secs }), null, `${secs}s must not produce a deadline`);
  }
});

test("a missing or unusable remainder yields null, not an Invalid Date", () => {
  for (const offer of [null, undefined, {}, { expires_in_sec: null }, { expires_in_sec: "soon" }]) {
    assert.strictEqual(deadlineFor(offer), null, `${JSON.stringify(offer)} must yield null`);
  }
});

test("the incoming-offer query asks the database for the remainder", () => {
  // The fix only works if the SECONDS are computed inside SQL, where both sides
  // of the subtraction are in the database's own clock.
  const src = require("node:fs").readFileSync(
    require.resolve("../util/dispatch/offers"),
    "utf8"
  );
  // includes() rather than a regex: the SQL lives in a template literal with
  // escaped backticks, and a failing regex assertion would dump the whole file.
  assert.ok(
    src.includes("TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP()"),
    "the remainder must be computed inside SQL, in the database's own clock"
  );
  assert.ok(
    src.includes("expires_in_sec"),
    "liveOfferForRider must select the remaining seconds"
  );
});

test("the rider endpoint sends the rebuilt deadline, never the raw column", () => {
  const src = require("node:fs").readFileSync(
    require.resolve("../controllers/deliveryOrders"),
    "utf8"
  );
  assert.match(src, /expires_at:\s*deadlineFor\(offer\)/);
  assert.doesNotMatch(
    src,
    /expires_at:\s*offer\.expires_at/,
    "passing the database's own timestamp through is the bug"
  );
});

test("offered_at stays a JS Date, which round-trips correctly", () => {
  // The opposite of the rule the rest of dispatch follows, and deliberately so:
  // Sequelize writes a Date in +05:30 and reads it back through the same
  // offset, so this column is the one on the row telling the truth. Switching
  // it to UTC_TIMESTAMP() would have broken a column that was already right.
  const src = require("node:fs").readFileSync(
    require.resolve("../util/deliveryDispatch"),
    "utf8"
  );
  assert.match(src, /offered_at:\s*new Date\(\)/);
});
