const test = require("node:test");
const assert = require("node:assert");
const { Op } = require("sequelize");

const { isAddressOnTheWay, STAGE } = require("../util/orderTracking");

// Whether a customer's address can be edited or deleted right now — blocked
// only while a rider is genuinely en route to it, the same "on the way"
// moment the tracking screen reports (see orderTracking.test.js for the stage
// machine itself). StoreOrders and the job loader are both injected fakes:
// this never touches a real database.

const fakeOrders = (rows) => ({ findAll: async () => rows });

test("blocks when a non-terminal order to this address has a rider carrying it", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 3 }]);
  const loadJob = async (orderId) => {
    assert.strictEqual(orderId, 1);
    return { status: "picked_up" };
  };
  assert.strictEqual(await isAddressOnTheWay(StoreOrders, 10, 20, loadJob), true);
});

test("does not block when the address has no orders at all", async () => {
  const StoreOrders = fakeOrders([]);
  let jobLoaded = false;
  const loadJob = async () => {
    jobLoaded = true;
    return null;
  };
  assert.strictEqual(await isAddressOnTheWay(StoreOrders, 10, 20, loadJob), false);
  assert.strictEqual(jobLoaded, false, "should not look up a job with no candidate orders");
});

test("does not block on an order still being prepared, not yet out for delivery", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 1 }]);
  const stage = await isAddressOnTheWay(StoreOrders, 10, 20, async () => null);
  assert.strictEqual(stage, false);
});

test("does not block on an order waiting for a rider to be found", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 3 }]);
  const loadJob = async () => ({ status: "offered", dispatch_state: "searching" });
  assert.strictEqual(await isAddressOnTheWay(StoreOrders, 10, 20, loadJob), false);
});

test("a second saved address with a different id is never blocked by this order", async () => {
  // findAll is already scoped to the address_id in its own where clause — this
  // just pins that the candidate list, not a broader "any active order",
  // is what decides the answer.
  const StoreOrders = { findAll: async ({ where }) => (where.address_id === 20 ? [{ order_id: 1, order_status: 4 }] : []) };
  const loadJob = async () => ({ status: "picked_up" });
  assert.strictEqual(await isAddressOnTheWay(StoreOrders, 10, 20, loadJob), true);
  assert.strictEqual(await isAddressOnTheWay(StoreOrders, 10, 21, loadJob), false);
});

test("excludes delivered and cancelled orders from the candidate query", async () => {
  let capturedWhere = null;
  const StoreOrders = {
    findAll: async (opts) => {
      capturedWhere = opts.where;
      return [];
    },
  };
  await isAddressOnTheWay(StoreOrders, 7, 9, async () => null);
  assert.strictEqual(capturedWhere.customer_id, 7);
  assert.strictEqual(capturedWhere.address_id, 9);
  assert.deepStrictEqual(capturedWhere.order_status[Op.notIn], [5, 6]);
});

test("a cancelled order with a stale 'picked up' delivery row does not block", async () => {
  // Mirrors orderTracking.test.js's own case for resolveStage: the dead end
  // must win even when the delivery row disagrees.
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 6 }]);
  const loadJob = async () => ({ status: "picked_up" });
  assert.strictEqual(await isAddressOnTheWay(StoreOrders, 10, 20, loadJob), false);
});

test("STAGE.ON_THE_WAY is the exact stage this guard keys off", () => {
  // Documents the coupling to orderTracking's stage machine rather than a
  // parallel definition of "on the way" living in this file.
  assert.strictEqual(STAGE.ON_THE_WAY, "on_the_way");
});
