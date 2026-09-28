// A rider handing a delivery back.
//
// The two decisions worth pinning down are where the job goes next and what it
// costs the rider's record. Both are pure, so they are tested here without a
// database, a push token or an SMTP host; the endpoint that uses them is
// exercised against the sandbox.
const test = require("node:test");
const assert = require("node:assert");

const orders = require("../controllers/deliveryOrders");
const adminNotify = require("../util/adminNotify");

const { _dispatchStateAfterCancel: stateAfter, _cancellationPct: pct } = orders;

// ── Where the job goes ─────────────────────────────────────────────

test("a cancellation before pickup goes back into the search", () => {
  // The restaurant still has the food, so another rider can simply be offered
  // it — most of the time the customer never notices.
  assert.strictEqual(stateAfter(false), "searching");
});

test("a cancellation after pickup parks for a human instead", () => {
  // 'failed' is what controllers/admin/dispatch.js unassigned selects on. It
  // must NOT be 'searching': the food is in the bag of the rider who just
  // walked away, so a replacement would ride to a counter with nothing on it.
  assert.strictEqual(stateAfter(true), "failed");
});

// ── What it costs the rider ────────────────────────────────────────

test("the rate counts cancellations against jobs actually committed to", () => {
  assert.strictEqual(pct(1, 3), 25);
  assert.strictEqual(pct(1, 1), 50);
  assert.strictEqual(pct(0, 40), 0);
});

test("a rider with no history reads as 0, not 100", () => {
  // Dividing by their own single job would put "100%" on the performance
  // screen of someone who has done nothing wrong yet.
  assert.strictEqual(pct(0, 0), 0);
  assert.strictEqual(pct(undefined, undefined), 0);
});

test("the rate keeps one decimal rather than rounding a rare event to zero", () => {
  // 1 in 200 is 0.5%, and a rider who cancels twice a year should not read as
  // a flat 0 — nor as 1%.
  assert.strictEqual(pct(1, 199), 0.5);
});

// ── The alert ──────────────────────────────────────────────────────

test("the admin alert never throws, even with every channel off", async () => {
  // Same contract as the other admin alerts: a rider's cancellation is already
  // committed by the time this runs, and a dead transport must not turn it
  // into a 500 the rider retries.
  const saved = process.env.ORDER_ESCALATION_CHANNELS;
  process.env.ORDER_ESCALATION_CHANNELS = "none";
  try {
    const result = await adminNotify.notifyAdminsRiderCancelled({
      orderId: 1,
      doId: 1,
      riderName: "Test Rider",
      reason: "Vehicle breakdown",
      afterPickup: true,
      hasPhoto: false,
      requeued: false,
    });
    assert.ok(result && typeof result === "object");
  } finally {
    if (saved === undefined) delete process.env.ORDER_ESCALATION_CHANNELS;
    else process.env.ORDER_ESCALATION_CHANNELS = saved;
  }
});
