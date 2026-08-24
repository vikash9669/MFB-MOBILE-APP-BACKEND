const test = require("node:test");
const assert = require("node:assert");

// Turning a paid intent into an order. Two properties matter here and both are
// about money:
//
//   the price is frozen   Settlement must use the figures the customer was
//                         quoted, not whatever the menu says now. Re-pricing
//                         let a mid-payment menu edit produce an order whose
//                         total was never agreed to and never collected.
//
//   the amount is checked The gateway must be holding what we asked for before
//                         anybody is given food.

const models = require("../models");
const orders = require("../util/orders");
// Stubbed so a mismatch alert is observable rather than a swallowed DB error.
const adminNotify = require("../util/adminNotify");

let updateCalls = [];
let intentRow = null;
let created = null;
let pricedWith = null;
let sideEffects = 0;
let alerts = [];

models.PaymentIntent.update = async (values, opts) => {
  updateCalls.push({ values, opts });
  // The claim: PENDING -> PAID succeeds once.
  if (values.status === "PAID") return [1];
  return [1];
};
models.PaymentIntent.findByPk = async () => intentRow;

orders.priceCart = async (args) => {
  pricedWith = args;
  return { productDetails: [{ product_id: 1, product_mrp: 999 }], order_amount: 999,
           order_discount: 0, delivery_charges: 0, payable: 999 };
};
orders.createOrder = async (args) => { created = args; return { order_id: 5150 }; };
orders.runPostOrderSideEffects = async () => { sideEffects += 1; };
adminNotify.notifyAdminsPaymentMismatch = async (a) => { alerts.push(a); return {}; };

delete require.cache[require.resolve("../util/paymentSettlement")];
const { settleIntent } = require("../util/paymentSettlement");

const QUOTED = {
  order_amount: 100, order_discount: 10, delivery_charges: 15, payable: 105,
  productDetails: [{ product_id: 42, product_mrp: 100 }],
};

const makeIntent = (over = {}) => ({
  pi_id: over.pi_id ?? 1,
  merchant_txn_id: "MFBTEST1",
  amount: 105,
  customer_id: 7,
  vendor_id: 3372,
  address_id: 25392,
  cart_snapshot: JSON.stringify({
    product_ids_with_quantity: { 42: 1 },
    coupon_code: null,
    platform: null,
    quoted: QUOTED,
  }),
  order_id: null,
  update: async function (v) { Object.assign(this, v); },
  ...over,
});

test.beforeEach(() => {
  updateCalls = []; created = null; pricedWith = null; sideEffects = 0; alerts = [];
  intentRow = makeIntent();
});

// ── the price lock ─────────────────────────────────────────────────────────

test("settlement uses the quoted prices and never re-prices the cart", async () => {
  await settleIntent(intentRow, "cf_1", 105);
  assert.equal(pricedWith, null, "priceCart must not be called when a quote exists");
  assert.equal(created.pricing.order_amount, 100);
  assert.equal(created.pricing.delivery_charges, 15);
  assert.equal(created.pricing.order_discount, 10);
  assert.deepEqual(created.pricing.productDetails, [{ product_id: 42, product_mrp: 100 }]);
});

test("a menu change between paying and settling cannot alter the order", async () => {
  // priceCart would return 999 if it were consulted. It must not be.
  await settleIntent(intentRow, "cf_1", 105);
  assert.notEqual(created.pricing.order_amount, 999, "the live menu must not leak in");
  assert.equal(created.payment.order_amount_paid, 105, "and the paid figure is the quote");
});

test("an intent from before the price lock still settles, by re-pricing", async () => {
  intentRow = makeIntent({
    cart_snapshot: JSON.stringify({ product_ids_with_quantity: { 42: 1 }, coupon_code: null }),
  });
  await settleIntent(intentRow, "cf_1", 105);
  assert.ok(pricedWith, "no quote means fall back rather than fail");
  assert.equal(created.pricing.order_amount, 999);
});

// ── the amount assertion ───────────────────────────────────────────────────

test("an exact match settles normally and alerts nobody", async () => {
  const r = await settleIntent(intentRow, "cf_1", 105);
  assert.equal(r.order_id, 5150);
  assert.equal(r.mismatch, undefined);
  assert.equal(sideEffects, 1);
  assert.equal(alerts.length, 0);
});

test("float noise is not treated as a mismatch", async () => {
  const r = await settleIntent(intentRow, "cf_1", 105.004);
  assert.equal(r.order_id, 5150, "a third of a paisa is not a discrepancy");
});

test("UNDERPAYMENT refuses to create an order, and tells admins", async () => {
  const r = await settleIntent(makeIntent({ pi_id: 2 }), "cf_1", 5);
  assert.equal(r.order_id, null);
  assert.equal(r.mismatch, true);
  assert.equal(created, null, "no order may exist for money we did not receive");
  assert.equal(updateCalls.length, 0, "the intent is left exactly as it was");
  assert.equal(alerts.length, 1);
  assert.deepEqual(
    { quoted: alerts[0].quoted, collected: alerts[0].collected, settled: alerts[0].settled },
    { quoted: 105, collected: 5, settled: false }
  );
});

test("a repeated sweep does not re-alert on the same intent", async () => {
  const intent = makeIntent({ pi_id: 99 });
  await settleIntent(intent, "cf_1", 5);
  await settleIntent(intent, "cf_1", 5);
  await settleIntent(intent, "cf_1", 5);
  assert.equal(alerts.length, 1, "a sweeper running every minute must not spam");
});

test("OVERPAYMENT still settles — the customer is not at fault", async () => {
  const r = await settleIntent(makeIntent({ pi_id: 3 }), "cf_1", 200);
  assert.equal(r.order_id, 5150);
  assert.equal(r.mismatch, undefined);
  assert.equal(alerts.length, 1, "but the difference still has to be refunded by hand");
  assert.equal(alerts[0].settled, true);
});

test("a driver that cannot report an amount does not block the payment", async () => {
  const r = await settleIntent(makeIntent({ pi_id: 4 }), "cf_1", null);
  assert.equal(r.order_id, 5150, "null means unknown, not zero");
});

test("the paid columns record the quote, whatever the gateway reports", async () => {
  await settleIntent(makeIntent({ pi_id: 5 }), "cf_txn_9", 105);
  assert.equal(created.payment.order_payment_type, "PG");
  assert.equal(created.payment.order_transaction_id, "cf_txn_9");
  assert.equal(created.payment.order_amount_paid, 105);
  assert.equal(created.payment.order_payment_status, 1);
});
