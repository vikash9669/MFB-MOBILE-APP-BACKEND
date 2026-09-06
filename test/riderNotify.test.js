const test = require("node:test");
const assert = require("node:assert");

const sequelize = require("../util/database");
const deliveryNotify = require("../util/deliveryNotify");
const riderNotify = require("../util/riderNotify");

// The five rider-facing process notifications.
//
// As with the customer side, what is worth testing is the SHAPING: whether the
// card carries what a rider needs to act (restaurant, distance, pay), whether
// the money is described correctly for COD versus prepaid, and whether the tap
// target is the one that will actually work. The push itself is util/fcm.js's
// problem and is covered there.

const JOB = {
  do_id: 42,
  dp_id: 7,
  source_order_id: 900001,
  order_ref: "900001",
  status: "accepted",
  pickup_name: "Chai Sutta Bar",
  pickup_lat: "24.6219552",
  pickup_lng: "74.6852769",
  drop_area: "Nimbahera",
  distance_km: "1.5",
  eta_min: 5,
  earn_total: "42.00",
  items_count: 3,
  payment_type: "COD",
  cash_to_collect: "275.00",
  cash_collected: 1,
  vendor_image: "vendor-77",
};

function stub(job = JOB) {
  const realQuery = sequelize.query;
  const realNotify = deliveryNotify.notifyPartner;
  const sent = [];
  sequelize.query = async () => (job ? [job] : []);
  deliveryNotify.notifyPartner = async (dpId, payload) => {
    sent.push({ dpId, payload });
    return { notif_id: 1 };
  };
  return {
    sent,
    restore: () => {
      sequelize.query = realQuery;
      deliveryNotify.notifyPartner = realNotify;
    },
  };
}

test("every rider alert is rendered by the app, not by Android", async () => {
  // `rich` is what makes the image and the buttons possible at all — a
  // notification Android drew itself can carry neither.
  const cases = [
    () => riderNotify.deliveryAssigned(42),
    () => riderNotify.orderPrepared(42),
    () => riderNotify.orderDelivered(42),
  ];
  for (const run of cases) {
    const s = stub();
    try {
      await run();
    } finally {
      s.restore();
    }
    assert.strictEqual(s.sent[0].payload.rich, true);
  }
});

test("an assignment tells the rider what they need to decide with", async () => {
  const s = stub();
  try {
    await riderNotify.deliveryAssigned(42);
  } finally {
    s.restore();
  }
  const { dpId, payload } = s.sent[0];
  assert.strictEqual(dpId, 7);
  // The old message was "Order #N has been assigned to you", which named none
  // of this.
  assert.match(payload.title, /New delivery · ₹42/);
  assert.match(payload.body, /Chai Sutta Bar/);
  assert.match(payload.body, /Nimbahera/);
  assert.match(payload.body, /1\.5 km/);
  assert.strictEqual(payload.route, "delivery:42");
  assert.deepStrictEqual(
    payload.actions.map(a => a.id),
    ["open", "navigate"],
  );
  // The Navigate button needs somewhere to go.
  assert.strictEqual(payload.data.pickup_lat, "24.6219552");
  assert.match(payload.image, /\/vendors\/webp\/vendor-77\.webp$/);
});

test("'food is ready' points at the store, not the customer", async () => {
  const s = stub();
  try {
    await riderNotify.orderPrepared(42);
  } finally {
    s.restore();
  }
  const { payload } = s.sent[0];
  assert.match(payload.title, /ready for pickup/i);
  assert.match(payload.body, /Chai Sutta Bar/);
  assert.strictEqual(payload.route, "delivery:42");
  assert.ok(payload.data.pickup_lat, "Navigate must have a destination");
});

test("the delivered alert accounts for the money, not just the earning", async () => {
  // COD, collected: the rider is now carrying the customer's cash, and that
  // is what gates whether they get offered more work.
  const collected = stub();
  try {
    await riderNotify.orderDelivered(42);
  } finally {
    collected.restore();
  }
  assert.match(collected.sent[0].payload.title, /you earned ₹42/);
  assert.match(collected.sent[0].payload.body, /₹275 cash collected/);

  // COD, not collected — a different situation and it must not read the same.
  const missed = stub({ ...JOB, cash_collected: 0 });
  try {
    await riderNotify.orderDelivered(42);
  } finally {
    missed.restore();
  }
  assert.match(missed.sent[0].payload.body, /not collected/i);

  // Prepaid: there was never anything to collect.
  const prepaid = stub({ ...JOB, payment_type: "PG", cash_to_collect: "0.00" });
  try {
    await riderNotify.orderDelivered(42);
  } finally {
    prepaid.restore();
  }
  assert.match(prepaid.sent[0].payload.body, /Paid online/);
});

test("approval routes to a refresh, never straight to a screen", async () => {
  const s = stub();
  try {
    await riderNotify.applicationApproved(7, "Vimal Ghawari");
  } finally {
    s.restore();
  }
  const { payload } = s.sent[0];
  assert.match(payload.title, /Congratulations, Vimal/);
  assert.match(payload.body, /delivering smiles/);
  // Sending them to a gate screen would bounce them back to the waiting room:
  // this device's token still says "pending" until it is re-minted.
  assert.strictEqual(payload.route, "refresh");
});

test("a job that has vanished notifies nobody rather than throwing", async () => {
  const s = stub(null);
  try {
    assert.strictEqual(await riderNotify.deliveryAssigned(42), null);
    assert.strictEqual(await riderNotify.orderPrepared(42), null);
  } finally {
    s.restore();
  }
  assert.strictEqual(s.sent.length, 0);
});

test("'ready' only reaches a rider who is waiting for the food", async () => {
  const { DeliveryOrder } = require("../models");
  const { notifyAssignedRiderReady } = require("../util/deliveryDispatch");
  const realFindOne = DeliveryOrder.findOne;

  // A rider holds the job and has not collected yet — the one case worth a
  // notification.
  let capturedWhere = null;
  DeliveryOrder.findOne = async opts => {
    capturedWhere = opts.where;
    return { do_id: 42, dp_id: 7 };
  };
  const s = stub();
  try {
    assert.strictEqual(await notifyAssignedRiderReady(900001), 42);
  } finally {
    s.restore();
    DeliveryOrder.findOne = realFindOne;
  }
  assert.strictEqual(s.sent.length, 1);
  assert.match(s.sent[0].payload.title, /ready for pickup/i);
  // 'picked_up' means the bag is already on the bike; telling them then is noise.
  assert.strictEqual(capturedWhere.status, "accepted");

  // Nobody assigned yet: dispatch is still looking, and there is no one to tell.
  DeliveryOrder.findOne = async () => ({ do_id: 42, dp_id: null });
  const none = stub();
  try {
    assert.strictEqual(await notifyAssignedRiderReady(900001), null);
  } finally {
    none.restore();
    DeliveryOrder.findOne = realFindOne;
  }
  assert.strictEqual(none.sent.length, 0);

  // No job at all — and it must not throw into the caller, which is a status
  // change that has already been committed.
  DeliveryOrder.findOne = async () => {
    throw new Error("database on fire");
  };
  try {
    assert.strictEqual(await notifyAssignedRiderReady(900001), null);
  } finally {
    DeliveryOrder.findOne = realFindOne;
  }
});

test("a failing push is swallowed — an approval must not be undone by it", async () => {
  const realQuery = sequelize.query;
  sequelize.query = async () => {
    throw new Error("database on fire");
  };
  try {
    assert.strictEqual(await riderNotify.deliveryAssigned(42), null);
    assert.strictEqual(await riderNotify.orderDelivered(42), null);
  } finally {
    sequelize.query = realQuery;
  }
});
