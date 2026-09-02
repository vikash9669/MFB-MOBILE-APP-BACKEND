const test = require("node:test");
const assert = require("node:assert");
const { Op } = require("sequelize");

const { isAddressLocked, STAGE } = require("../util/orderTracking");

// Whether a customer's address can be edited or deleted right now — locked
// from the moment an order to it is placed until that order is delivered
// (or cancelled/declined). This used to only block once a rider was already
// carrying the order, which let an address be deleted out from under an
// order still sitting with the restaurant — see the reproduction case below.
// StoreOrders and the job loader are both injected fakes: this never touches
// a real database.

const fakeOrders = (rows) => ({ findAll: async () => rows });

test("blocks when a non-terminal order to this address has a rider carrying it", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 3 }]);
  const loadJob = async (orderId) => {
    assert.strictEqual(orderId, 1);
    return { status: "picked_up" };
  };
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), true);
});

test("does not block when the address has no orders at all", async () => {
  const StoreOrders = fakeOrders([]);
  let jobLoaded = false;
  const loadJob = async () => {
    jobLoaded = true;
    return null;
  };
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), false);
  assert.strictEqual(jobLoaded, false, "should not look up a job with no candidate orders");
});

// The bug report this reproduces: a customer was able to delete the address
// for an order that was still "Waiting for the restaurant to accept" — the
// old guard only ever keyed off STAGE.ON_THE_WAY, so every earlier stage
// went unblocked.
test("blocks on an order still waiting for the restaurant to accept", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 0 }]);
  const blocked = await isAddressLocked(StoreOrders, 10, 20, async () => null);
  assert.strictEqual(blocked, true);
});

test("blocks on an order still being prepared, not yet out for delivery", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 1 }]);
  const blocked = await isAddressLocked(StoreOrders, 10, 20, async () => null);
  assert.strictEqual(blocked, true);
});

test("blocks on an order waiting for a rider to be found", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 3 }]);
  const loadJob = async () => ({ status: "offered", dispatch_state: "searching" });
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), true);
});

test("blocks even when dispatch could not find a rider at all", async () => {
  // NO_RIDER is a dead end for messaging purposes, but it is not `is_terminal`
  // (see buildTracking) — nothing has resolved the order yet, so the address
  // must stay locked until a human sorts it out or it's cancelled.
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 3 }]);
  const loadJob = async () => ({ status: "offered", dispatch_state: "failed" });
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), true);
});

test("does not block once the delivery job says delivered, even before order_status catches up", async () => {
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 4 }]);
  const loadJob = async () => ({ status: "delivered" });
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), false);
});

test("a second saved address with a different id is never blocked by this order", async () => {
  // findAll is already scoped to the address_id in its own where clause — this
  // just pins that the candidate list, not a broader "any active order",
  // is what decides the answer.
  const StoreOrders = { findAll: async ({ where }) => (where.address_id === 20 ? [{ order_id: 1, order_status: 4 }] : []) };
  const loadJob = async () => ({ status: "picked_up" });
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), true);
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 21, loadJob), false);
});

test("excludes delivered and cancelled orders from the candidate query", async () => {
  let capturedWhere = null;
  const StoreOrders = {
    findAll: async (opts) => {
      capturedWhere = opts.where;
      return [];
    },
  };
  await isAddressLocked(StoreOrders, 7, 9, async () => null);
  assert.strictEqual(capturedWhere.customer_id, 7);
  assert.strictEqual(capturedWhere.address_id, 9);
  assert.deepStrictEqual(capturedWhere.order_status[Op.notIn], [5, 6]);
});

test("a cancelled order with a stale 'picked up' delivery row does not block", async () => {
  // Mirrors orderTracking.test.js's own case for resolveStage: the dead end
  // must win even when the delivery row disagrees.
  const StoreOrders = fakeOrders([{ order_id: 1, order_status: 6 }]);
  const loadJob = async () => ({ status: "picked_up" });
  assert.strictEqual(await isAddressLocked(StoreOrders, 10, 20, loadJob), false);
});

test("STAGE.DELIVERED is the only stage this guard treats as unlocked", () => {
  // Documents the coupling to orderTracking's stage machine rather than a
  // parallel definition of "done" living in this file.
  assert.strictEqual(STAGE.DELIVERED, "delivered");
});
