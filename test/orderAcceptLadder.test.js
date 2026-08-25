const test = require("node:test");
const assert = require("node:assert");

// The escalation ladder: admin escalation, then email-to-both, then auto-cancel,
// each once and in order. Config is read into module-level consts at require
// time, so the thresholds are set before the requires below. Compressed to
// 1/2/3 minutes so the simulated clock stays readable; reminders and give-up are
// pushed out of the way so only the three tiers under test can fire.
process.env.ORDER_ACCEPT_REMINDER_EVERY_MIN = "99";
process.env.ORDER_ACCEPT_GIVE_UP_MIN = "99";
process.env.ORDER_ACCEPT_ESCALATE_MIN = "1";
process.env.ORDER_ACCEPT_EMAIL_ALL_MIN = "2";
process.env.ORDER_ACCEPT_CANCEL_MIN = "3";
process.env.ORDER_AUTO_CANCEL = "true";
process.env.VENDOR_ALERT_CHANNELS = "none";

const { StoreOrders, User, Business } = require("../models");

// cancelOrder is destructured into a const inside the sweeper at require time,
// so it must be replaced on the module BEFORE the sweeper is required — a later
// swap would not reach the captured reference.
const lifecycle = require("../util/orderLifecycle");
lifecycle.cancelOrder = async () => ({ ok: true, refund: null });

const { sweepOnce, stageOf, _reset } = require("../util/orderAcceptSweeper");

// escalate() and emailAll() re-require the notify controller on each call, so
// stubbing its exports here is enough — no network, no email, no DB writes.
const notify = require("../controllers/admin/notify");
let escalateCalls = 0;
let emailCalls = 0;
notify.escalateUnaccepted = async () => {
  escalateCalls += 1;
};
notify.escalateUnacceptedEmail = async () => {
  emailCalls += 1;
};
notify.notifyOrderAutoCancelled = async () => {};

const PENDING = {
  order_id: 501,
  order_status: 0,
  vendor_id: null, // keeps vendorOf() off the database
  order_amount: 100,
  delivery_charges: 0,
  order_discount: 0,
  order_payment_type: "COD",
};

test("escalate → email-both → cancel fire in order, once each, with matching stageOf", async () => {
  const realNow = Date.now;
  const realMax = StoreOrders.max;
  const realFindAll = StoreOrders.findAll;
  const realUser = User.findByPk;
  const realBiz = Business.findOne;

  let clock = realNow();
  Date.now = () => clock;
  const advanceMin = (m) => {
    clock += m * 60000;
  };

  StoreOrders.max = async () => 500; // watermark below our order
  StoreOrders.findAll = async () => [{ ...PENDING }];
  User.findByPk = async () => null;
  Business.findOne = async () => null;

  _reset();
  escalateCalls = 0;
  emailCalls = 0;

  try {
    await sweepOnce(); // establishes the watermark, chases nothing
    await sweepOnce(); // sees #501, starts its clock
    assert.strictEqual(stageOf(501), 0, "a freshly seen order is stage 0");

    advanceMin(1.1); // past ESCALATE_MIN
    let r = await sweepOnce();
    assert.deepStrictEqual(r.escalated, ["#501"], "admin escalation should fire after ~1 min");
    assert.strictEqual(escalateCalls, 1);
    assert.strictEqual(stageOf(501), 1, "stage climbs to 1 after escalation");

    advanceMin(1.1); // ~2.2 min, past EMAIL_ALL_MIN
    r = await sweepOnce();
    assert.deepStrictEqual(r.emailed, ["#501"], "email-to-both should fire after ~2 min");
    assert.strictEqual(emailCalls, 1);
    assert.strictEqual(stageOf(501), 2, "stage climbs to 2 after the email tier");

    advanceMin(1.1); // ~3.3 min, past CANCEL_MIN
    r = await sweepOnce();
    assert.deepStrictEqual(r.cancelled, ["#501"], "auto-cancel should fire after ~3 min");

    // The whole point of the flags: another tick at the same clock must not
    // re-escalate or re-email. (Cancel is guarded by the order leaving the
    // pending set in production; the two alert tiers are guarded here.)
    await sweepOnce();
    assert.strictEqual(escalateCalls, 1, "escalation must be sent exactly once");
    assert.strictEqual(emailCalls, 1, "the email tier must be sent exactly once");
  } finally {
    Date.now = realNow;
    StoreOrders.max = realMax;
    StoreOrders.findAll = realFindAll;
    User.findByPk = realUser;
    Business.findOne = realBiz;
  }
});

test("stageOf is 0 for an order the sweeper is not tracking", () => {
  _reset();
  assert.strictEqual(stageOf(999999), 0);
});
