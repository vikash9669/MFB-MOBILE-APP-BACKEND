const test = require("node:test");
const assert = require("node:assert");

// Config is read into module-level consts at require time, so it has to be set
// before the require below. Short intervals keep the simulated clock readable.
process.env.ORDER_ACCEPT_REMINDER_EVERY_MIN = "1";
process.env.ORDER_ACCEPT_GIVE_UP_MIN = "5";
process.env.ORDER_ACCEPT_ESCALATE_MIN = "999"; // out of the way for this test
process.env.ORDER_ACCEPT_EMAIL_ALL_MIN = "999"; // out of the way for this test
process.env.ORDER_AUTO_CANCEL = "false";
process.env.VENDOR_ALERT_CHANNELS = "none"; // no channel enabled: no network calls

const { StoreOrders, User, Business } = require("../models");
const { sweepOnce } = require("../util/orderAcceptSweeper");

// One order, stuck at "Received" forever — the exact situation that produced
// 212 duplicate SMS to one vendor for order #276439.
const STUCK = {
  order_id: 101,
  order_status: 0,
  vendor_id: null, // keeps vendorOf() from touching the database
  order_amount: 250,
  delivery_charges: 0,
  order_discount: 0,
  order_payment_type: "COD",
};

test("a vendor who never accepts is chased a bounded number of times, then left alone", async () => {
  const realNow = Date.now;
  const realMax = StoreOrders.max;
  const realFindAll = StoreOrders.findAll;
  const realUserFind = User.findByPk;
  const realBizFind = Business.findOne;

  let clock = realNow();
  Date.now = () => clock;
  const advanceSeconds = (s) => {
    clock += s * 1000;
  };

  StoreOrders.max = async () => 100; // watermark below our order
  StoreOrders.findAll = async () => [{ ...STUCK }]; // never accepted, never cancelled
  User.findByPk = async () => null;
  Business.findOne = async () => null;

  try {
    await sweepOnce(); // first run only establishes the watermark
    await sweepOnce(); // sees #101 and starts its clock

    // Two simulated hours at the real 30-second tick.
    let remindersInFirstTenMinutes = 0;
    let remindersAfterwards = 0;
    for (let tick = 0; tick < 240; tick += 1) {
      advanceSeconds(30);
      const { reminded } = await sweepOnce();
      if (tick < 20) remindersInFirstTenMinutes += reminded.length;
      else remindersAfterwards += reminded.length;
    }

    // Up to the give-up mark the vendor is chased once a minute — that part is
    // the feature and should still work.
    assert.ok(
      remindersInFirstTenMinutes > 0,
      "the vendor was never chased at all — the reminder ladder is broken"
    );
    assert.ok(
      remindersInFirstTenMinutes <= 6,
      `chased ${remindersInFirstTenMinutes} times inside the 5-minute window; expected at most 6`
    );

    // THE REGRESSION. The give-up used to delete the tracking entry while the
    // order was still pending, so the next tick re-added it as if it were new
    // and the whole ladder ran again — forever. Over these 110 simulated
    // minutes the old code sent roughly twenty more reminders.
    assert.strictEqual(
      remindersAfterwards,
      0,
      `sent ${remindersAfterwards} reminders after giving up — the chase restarted`
    );
  } finally {
    Date.now = realNow;
    StoreOrders.max = realMax;
    StoreOrders.findAll = realFindAll;
    User.findByPk = realUserFind;
    Business.findOne = realBizFind;
  }
});

test("an order that gets accepted stops being tracked", async () => {
  const realNow = Date.now;
  const realFindAll = StoreOrders.findAll;
  let clock = realNow();
  Date.now = () => clock;

  try {
    // #101 is gone from the pending set — somebody accepted it.
    StoreOrders.findAll = async () => [];
    const result = await sweepOnce();
    assert.strictEqual(result.tracking, 0, "an accepted order is still being tracked");
    assert.deepStrictEqual(result.reminded, []);
  } finally {
    Date.now = realNow;
    StoreOrders.findAll = realFindAll;
  }
});
