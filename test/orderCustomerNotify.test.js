const test = require("node:test");
const assert = require("node:assert");

const sequelize = require("../util/database");
const customerNotify = require("../util/customerNotify");
const notify = require("../util/orderCustomerNotify");

// The six customer-facing order notifications.
//
// What is worth testing here is the SHAPING, not the sending: whether the text
// names the right food and restaurant, whether the picture is the right
// picture, and whether the payload carries the stage the app routes on. The
// push itself is util/fcm.js's problem and is already covered.
//
// Every test stubs sequelize.query and customerNotify.notifyUser, so nothing
// here touches a database or a device.

const ORDER_ROW = {
  order_id: 900001,
  customer_id: 55,
  vendor_id: 77,
  order_prep_minutes: 20,
  business_name: "Chai Sutta Bar",
  vendor_image: "vendor-77",
};

const ITEM_ROWS = [
  { product_name: "Paneer Tikka", product_image: "prod-1" },
  { product_name: "Masala Chai", product_image: "prod-2" },
  { product_name: "Fries", product_image: "prod-3" },
];

/**
 * Stubs sequelize.query, dispatching on what the SQL is asking for, and
 * captures whatever notifyUser is handed. Returns { sent, restore }.
 */
function stub({ order = ORDER_ROW, items = ITEM_ROWS, job, events = 0 } = {}) {
  const realQuery = sequelize.query;
  const realNotify = customerNotify.notifyUser;
  const sent = [];

  sequelize.query = async (sql) => {
    if (sql.includes("store_orders_details")) return items;
    if (sql.includes("FROM `store_orders`")) return order ? [order] : [];
    if (sql.includes("store_delivery_orders")) return job ? [job] : [];
    if (sql.includes("store_delivery_order_events")) return [{ seen: events }];
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  customerNotify.notifyUser = async (userId, payload) => {
    sent.push({ userId, payload });
    return { notif_id: 1 };
  };

  return {
    sent,
    restore: () => {
      sequelize.query = realQuery;
      customerNotify.notifyUser = realNotify;
    },
  };
}

test("placing an order names the food and the restaurant, not the order number", async () => {
  const s = stub();
  try {
    await notify.orderPlaced(900001);
  } finally {
    s.restore();
  }

  assert.strictEqual(s.sent.length, 1);
  const { userId, payload } = s.sent[0];
  assert.strictEqual(userId, 55);
  assert.strictEqual(payload.title, "Order placed 🎉");
  // The old message was "We've received order #900001", which told the
  // customer nothing they did not already know.
  assert.match(payload.body, /Paneer Tikka \+2 more from Chai Sutta Bar/);
  assert.strictEqual(payload.category, "orders");
  assert.strictEqual(payload.refOrderId, 900001);
  assert.strictEqual(payload.refStage, "placed");
  assert.strictEqual(payload.data.stage, "placed");
  // The food, for the order that was just placed.
  assert.match(payload.image, /\/products\/webp\/prod-1\.webp$/);
});

test("vendor acceptance leads with the restaurant and carries its picture", async () => {
  const s = stub();
  try {
    await notify.orderAccepted(900001, 25);
  } finally {
    s.restore();
  }

  const { payload } = s.sent[0];
  assert.strictEqual(payload.title, "Chai Sutta Bar is preparing your order 👨‍🍳");
  assert.match(payload.body, /ready in about 25 min/);
  assert.strictEqual(payload.refStage, "preparing");
  assert.match(payload.image, /\/vendors\/webp\/vendor-77\.webp$/);
});

test("the four delivery moments each say who, and carry the right stage", async () => {
  const cases = [
    [notify.riderAssigned, "assigned", /Suresh will deliver your order/, /picked up shortly/],
    [notify.orderPickedUp, "picked_up", /Order picked up/, /Suresh has your order from Chai Sutta Bar/],
    [notify.riderNearby, "arriving", /Almost there/, /Suresh is about to reach you/],
    [notify.orderDelivered, "delivered", /Delivered/, /How was Suresh\?/],
  ];

  for (const [fn, stage, titleRe, bodyRe] of cases) {
    const s = stub();
    try {
      await fn(900001, "Suresh Kumar");
    } finally {
      s.restore();
    }
    const { payload } = s.sent[0];
    assert.match(payload.title, titleRe, `title for ${stage}`);
    assert.match(payload.body, bodyRe, `body for ${stage}`);
    assert.strictEqual(payload.refStage, stage);
    assert.strictEqual(payload.data.stage, stage);
    // First name only — "Suresh Kumar is bringing your order" reads like a
    // system message about a record rather than a person at the door.
    assert.ok(!payload.body.includes("Kumar"), `${stage} should use the first name only`);
  }
});

test("only the delivered push asks the app to open the rating card", async () => {
  for (const fn of [notify.riderAssigned, notify.orderPickedUp, notify.riderNearby]) {
    const s = stub();
    try {
      await fn(900001, "Suresh");
    } finally {
      s.restore();
    }
    assert.strictEqual(s.sent[0].payload.data.focus, undefined);
  }

  const s = stub();
  try {
    await notify.orderDelivered(900001, "Suresh");
  } finally {
    s.restore();
  }
  assert.strictEqual(s.sent[0].payload.data.focus, "rating");
});

test("a nameless rider and a nameless restaurant still produce sentences", async () => {
  const s = stub({
    order: { ...ORDER_ROW, business_name: null, vendor_image: null },
    items: [],
  });
  try {
    await notify.riderAssigned(900001, null);
    await notify.orderPlaced(900001);
  } finally {
    s.restore();
  }

  const assigned = s.sent[0].payload;
  assert.strictEqual(assigned.title, "A delivery partner is on the way 🛵");
  // No dangling "from " with nothing after it.
  assert.ok(!assigned.body.includes("from "), assigned.body);

  const placed = s.sent[1].payload;
  assert.match(placed.body, /^Your order\./);
  assert.strictEqual(placed.image, null);
});

test("an order that no longer exists notifies nobody rather than throwing", async () => {
  const s = stub({ order: null });
  try {
    const result = await notify.orderPlaced(900001);
    assert.strictEqual(result, null);
  } finally {
    s.restore();
  }
  assert.strictEqual(s.sent.length, 0);
});

test("a failing push is swallowed — it must never undo the action behind it", async () => {
  const realQuery = sequelize.query;
  sequelize.query = async () => {
    throw new Error("database on fire");
  };
  try {
    // No rejection: acceptOrder, verifyPickup and verifyDelivery all call these
    // from a path that has already committed.
    assert.strictEqual(await notify.orderPlaced(900001), null);
    assert.strictEqual(await notify.orderDelivered(900001, "Suresh"), null);
  } finally {
    sequelize.query = realQuery;
  }
});

test("'almost there' fires inside the radius and not outside it", async () => {
  // Drop point, and a rider ~250 m north of it (0.00225° latitude).
  const drop = { drop_lat: 22.76, drop_lng: 75.84, do_id: 5, source_order_id: 900001 };
  const near = [22.76225, 75.84];
  const far = [22.79, 75.84]; // ~3.3 km

  const outside = stub({ job: drop });
  try {
    const r = await notify.checkNearDrop(9, far[0], far[1]);
    assert.strictEqual(r.notified, false);
    assert.strictEqual(r.reason, "still far");
  } finally {
    outside.restore();
  }
  assert.strictEqual(outside.sent.length, 0, "nothing should be sent from 3km away");

  // Inside the radius the notification goes out. logOrderEvent and the partner
  // lookup are the only things left touching real modules, so they are stubbed
  // through the same query hook plus a direct patch below.
  const inside = stub({ job: drop });
  const { DeliveryPartner } = require("../models");
  const realFindByPk = DeliveryPartner.findByPk;
  const { DeliveryOrderEvent } = require("../models");
  const realCreate = DeliveryOrderEvent.create;
  DeliveryPartner.findByPk = async () => ({ dp_name: "Suresh Kumar" });
  DeliveryOrderEvent.create = async () => ({ id: 1 });
  try {
    const r = await notify.checkNearDrop(9, near[0], near[1]);
    assert.strictEqual(r.notified, true, JSON.stringify(r));
    assert.ok(r.km < notify.NEAR_DROP_KM);
  } finally {
    DeliveryPartner.findByPk = realFindByPk;
    DeliveryOrderEvent.create = realCreate;
    inside.restore();
  }
  assert.strictEqual(inside.sent.length, 1);
  assert.strictEqual(inside.sent[0].payload.refStage, "arriving");
  assert.match(inside.sent[0].payload.body, /Suresh is about to reach you/);
});

test("'almost there' is said once, however many fixes arrive", async () => {
  // events: 1 — the near_drop marker is already on the job's timeline. The
  // rider app sends a fix every minute, so without this the customer would be
  // told to be ready once a minute for the whole last stretch.
  const s = stub({
    job: { drop_lat: 22.76, drop_lng: 75.84, do_id: 5, source_order_id: 900001 },
    events: 1,
  });
  try {
    const r = await notify.checkNearDrop(9, 22.76025, 75.84);
    assert.strictEqual(r.notified, false);
    assert.strictEqual(r.reason, "already told them");
  } finally {
    s.restore();
  }
  assert.strictEqual(s.sent.length, 0);
});

test("no job in flight, or a drop with no pin, is a quiet no-op", async () => {
  const none = stub({ job: null });
  try {
    assert.strictEqual((await notify.checkNearDrop(9, 22.76, 75.84)).reason, "no job in flight");
  } finally {
    none.restore();
  }

  // Addresses inherited from the PHP panel can still have no coordinates.
  const noPin = stub({ job: { do_id: 5, source_order_id: 900001, drop_lat: null, drop_lng: null } });
  try {
    const r = await notify.checkNearDrop(9, 22.76, 75.84);
    assert.strictEqual(r.reason, "drop has no coordinates");
  } finally {
    noPin.restore();
  }
});

test("item summaries read like a person wrote them", () => {
  assert.strictEqual(notify._itemSummary({ firstItem: "Fries", itemCount: 1 }), "Fries");
  assert.strictEqual(notify._itemSummary({ firstItem: "Fries", itemCount: 2 }), "Fries +1 more");
  assert.strictEqual(notify._itemSummary({ firstItem: null, itemCount: 0 }), "Your order");
});
