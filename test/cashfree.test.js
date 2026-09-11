const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

// Unit tests for the Cashfree driver and the gateway that resolves it.
//
// No network. What is exercised here is the set of mistakes that actually cost
// money at this layer: sending paise where rupees are expected, accepting a
// forged webhook, mapping a provider's status vocabulary onto ours incorrectly,
// and losing refund idempotency. Each of those is silent in production and
// obvious in a test.
//
// `node --test` gives every file its own process, so stubbing the shared axios
// module here cannot leak into the other suites.

const axios = require("axios");

let queued = [];
let calls = [];

axios.post = async (url, body, cfg) => {
  calls.push({ method: "post", url, body, cfg });
  const next = queued.shift();
  if (!next) throw new Error(`unexpected POST ${url}`);
  return next;
};
axios.get = async (url, cfg) => {
  calls.push({ method: "get", url, cfg });
  const next = queued.shift();
  if (!next) throw new Error(`unexpected GET ${url}`);
  return next;
};

const reply = (data, status = 200) => ({ data, status });

const CREDS = {
  CASHFREE_CLIENT_ID: "TEST_APP_ID",
  CASHFREE_CLIENT_SECRET: "test-secret-key",
  CASHFREE_ENV: "UAT",
};

const withEnv = (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const load = (mod) => {
  delete require.cache[require.resolve(mod)];
  return require(mod);
};

test.beforeEach(() => {
  queued = [];
  calls = [];
});

// ── amounts ────────────────────────────────────────────────────────────────
// Cashfree bills in RUPEES. Other gateways in this market bill in paise, so a
// *100 conversion copied in from one of them would charge every customer a
// hundred times the order value — and nothing downstream would notice, because
// the intent, the order and the receipt would all agree with each other.

test("order amount is sent in RUPEES, not paise", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFB1", cf_order_id: "cf_1", payment_session_id: "sess_1" }));

    await cashfree.createOrder({ merchantOrderId: "MFB1", amountInRupees: 349.5, userId: 7 });

    assert.equal(calls[0].body.order_amount, 349.5);
    assert.notEqual(calls[0].body.order_amount, 34950);
    assert.equal(calls[0].body.order_currency, "INR");
  });
});

test("a fractional rupee amount is rounded to two decimals, not truncated", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFB2", payment_session_id: "s" }));
    await cashfree.createOrder({ merchantOrderId: "MFB2", amountInRupees: 10.005, userId: 1 });
    assert.equal(calls[0].body.order_amount, 10.01);
  });
});

test("refund amount is also in rupees", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ refund_status: "PENDING", cf_refund_id: "cfr_1", refund_amount: 200 }));
    await cashfree.refundPayment({
      merchantRefundId: "RFB12",
      originalMerchantOrderId: "MFB1",
      amountInRupees: 200,
    });
    assert.equal(calls[0].body.refund_amount, 200);
  });
});

// ── auth + request shape ───────────────────────────────────────────────────

test("credentials travel as headers, and there is no OAuth round trip", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFB3", payment_session_id: "s" }));
    await cashfree.createOrder({ merchantOrderId: "MFB3", amountInRupees: 100, userId: 1 });

    assert.equal(calls.length, 1, "exactly one call — no token fetch");
    const h = calls[0].cfg.headers;
    assert.equal(h["x-client-id"], "TEST_APP_ID");
    assert.equal(h["x-client-secret"], "test-secret-key");
    assert.equal(h["x-api-version"], "2026-01-01");
  });
});

test("sandbox and production hit different hosts", async () => {
  await withEnv({ ...CREDS, CASHFREE_ENV: "PROD" }, async () => {
    const cashfree = load("../util/cashfree");
    assert.match(cashfree.config().api, /^https:\/\/api\.cashfree\.com\/pg$/);
    assert.equal(cashfree.config().sdk, "PRODUCTION");
  });
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    assert.match(cashfree.config().api, /sandbox\.cashfree\.com/);
    assert.equal(cashfree.config().sdk, "SANDBOX");
  });
});

test("isConfigured needs both id and secret", () => {
  withEnv({ CASHFREE_CLIENT_ID: "x", CASHFREE_CLIENT_SECRET: undefined }, () => {
    assert.equal(load("../util/cashfree").isConfigured(), false);
  });
  withEnv(CREDS, () => {
    assert.equal(load("../util/cashfree").isConfigured(), true);
  });
});

// ── customer block ─────────────────────────────────────────────────────────
// customer_phone is mandatory and must be ten digits. A legacy row without one
// must not be able to fail an otherwise good checkout.

test("a real phone is used, and junk falls back to a placeholder", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");

    queued.push(reply({ order_id: "A", payment_session_id: "s" }));
    await cashfree.createOrder({
      merchantOrderId: "A",
      amountInRupees: 1,
      userId: 5,
      customer: { id: 5, phone: "+91 76655-17111" },
    });
    assert.equal(calls[0].body.customer_details.customer_phone, "7665517111");

    calls = [];
    queued.push(reply({ order_id: "B", payment_session_id: "s" }));
    await cashfree.createOrder({
      merchantOrderId: "B",
      amountInRupees: 1,
      userId: 5,
      customer: { id: 5, phone: "n/a" },
    });
    assert.equal(calls[0].body.customer_details.customer_phone.length, 10);
  });
});

test("a fabricated example.com address is never sent to Cashfree", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "C", payment_session_id: "s" }));
    await cashfree.createOrder({
      merchantOrderId: "C",
      amountInRupees: 1,
      userId: 5,
      customer: { id: 5, phone: "9999999999", email: "dp123@example.com" },
    });
    assert.equal(calls[0].body.customer_details.customer_email, undefined);
  });
});

test("a non-https notify_url is dropped rather than sent", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "D", payment_session_id: "s" }));
    await cashfree.createOrder({
      merchantOrderId: "D",
      amountInRupees: 1,
      userId: 1,
      notifyUrl: "http://localhost:8080/payment/callback",
    });
    assert.equal(calls[0].body.order_meta?.notify_url, undefined);
  });
});

// ── status mapping ─────────────────────────────────────────────────────────

test("PAID is success, EXPIRED is neither", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");

    queued.push(reply({ order_status: "EXPIRED", cf_order_id: "cf1" }));
    let s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, false);
    assert.equal(s.success, false);

    queued.push(reply({ order_status: "PAID", cf_order_id: "cf1" }));
    queued.push(reply([{ payment_status: "SUCCESS", cf_payment_id: 555, payment_group: "upi" }]));
    s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.success, true);
    assert.equal(s.providerTxnId, "555");
    assert.equal(s.instrument, "upi");
  });
});

// ── ACTIVE: in flight, or abandoned? ───────────────────────────────────────
//
// order_status ACTIVE means only "no successful payment yet". It covers money
// genuinely moving at the customer's bank AND a checkout sheet they opened and
// backed out of. Calling both PENDING is what stranded customers on "Payment is
// still being confirmed by the bank — do not pay again" with Pay Now disabled,
// waiting on a confirmation that was never coming. Only the per-attempt
// payment_status separates them.

const ACTIVE_NOW = (extra = {}) => ({
  order_status: "ACTIVE",
  cf_order_id: "cf1",
  created_at: new Date().toISOString(),
  ...extra,
});

test("ACTIVE with an attempt still running is pending", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply(ACTIVE_NOW()));
    queued.push(reply([{ payment_status: "PENDING", cf_payment_id: 1 }]));
    const s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, true, "money may be in flight — never say failed");
    assert.equal(s.success, false);
  });
});

test("ACTIVE with a dropped attempt is a retryable failure, not pending", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    // The exact case from the customer app: sheet opened, customer backed out.
    for (const status of ["USER_DROPPED", "FAILED", "CANCELLED", "VOID"]) {
      queued.push(reply(ACTIVE_NOW()));
      queued.push(reply([{ payment_status: status, cf_payment_id: 1 }]));
      const s = await cashfree.fetchStatus("MFB1");
      assert.equal(s.pending, false, `${status} must not read as pending`);
      assert.equal(s.success, false, `${status} must not read as paid`);
    }
  });
});

test("NOT_ATTEMPTED is a placeholder, not a failed attempt", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    // Cashfree stamps one of these on an order the moment it is created.
    // Reading it as a finished attempt made every freshly raised doorstep QR
    // FAILED on its first status poll, and let a second payment link be opened
    // for the same delivery. Only the live API produces these rows, which is
    // why the stubs above never caught it.
    queued.push(reply(ACTIVE_NOW()));
    queued.push(reply([{ payment_status: "NOT_ATTEMPTED", cf_payment_id: 1 }]));
    let s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, true, "nothing has been tried yet — still waiting");

    // And it must not shortcut the window either: past it, still abandoned.
    queued.push(reply(ACTIVE_NOW({ created_at: new Date(Date.now() - 3_600_000).toISOString() })));
    queued.push(reply([{ payment_status: "NOT_ATTEMPTED" }]));
    s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, false, "beyond the window it is abandoned");
    assert.equal(s.message, "Payment was not completed", "not 'attempt did not succeed'");
  });
});

test("a dropped attempt reports why, so the customer can be told to retry", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply(ACTIVE_NOW()));
    queued.push(reply([{ payment_status: "FAILED", payment_message: "Insufficient funds" }]));
    const s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.message, "Insufficient funds");
  });
});

test("a fresh order with no attempt yet is pending, an old one is not", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");

    // The SDK has just opened; Cashfree has not recorded an attempt yet.
    // Declaring this failed would write off payments about to happen.
    queued.push(reply(ACTIVE_NOW()));
    queued.push(reply([]));
    let s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, true, "inside the grace window");

    // Long past that, an order nobody ever tried to pay is abandoned.
    queued.push(reply(ACTIVE_NOW({ created_at: new Date(Date.now() - 3_600_000).toISOString() })));
    queued.push(reply([]));
    s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, false, "beyond the grace window");
  });
});

test("the caller decides how long 'no attempt yet' is normal", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    // A doorstep QR legitimately sits untouched for minutes while the customer
    // finds their phone — the opposite of a checkout SDK, where the customer is
    // back within seconds. Applying the checkout window to a QR marked live
    // collections FAILED and let a second payment link be opened for the same
    // delivery. Observed in the sandbox.
    const old = { order_status: "ACTIVE", created_at: new Date(Date.now() - 5 * 60_000).toISOString() };

    queued.push(reply(old));
    queued.push(reply([]));
    let s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, false, "five minutes is abandoned at checkout");

    queued.push(reply(old));
    queued.push(reply([]));
    s = await cashfree.fetchStatus("MFB1", { noAttemptGraceMs: 15 * 60_000 });
    assert.equal(s.pending, true, "five minutes is still waiting at the door");
  });
});

test("a caller-supplied window never overrides a finished attempt", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    // The window only covers "nothing has been tried". Once an attempt exists
    // and is dead, no amount of patience makes it pending again.
    queued.push(reply({ order_status: "ACTIVE", created_at: new Date().toISOString() }));
    queued.push(reply([{ payment_status: "USER_DROPPED" }]));
    const s = await cashfree.fetchStatus("MFB1", { noAttemptGraceMs: 60 * 60_000 });
    assert.equal(s.pending, false);
  });
});

test("an unusable payments list falls back to pending, never to failed", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    // Nothing queued for the payments call, so the stub throws. Guessing
    // "failed" here could invite a second charge on a live payment; guessing
    // "pending" only costs a retry.
    queued.push(reply({ order_status: "ACTIVE", cf_order_id: "cf1" }));
    const s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.pending, true);
    assert.equal(s.success, false);
  });
});

test("a paid order still settles when the payments lookup fails", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_status: "PAID", cf_order_id: "cf_fallback" }));
    // Nothing queued for the payments call, so the stub throws.
    const s = await cashfree.fetchStatus("MFB1");
    assert.equal(s.success, true, "a lookup failure must not lose the payment");
    assert.equal(s.providerTxnId, "cf_fallback");
  });
});

test("an HTTP error is reported, never mistaken for success", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ message: "order not found" }, 404));
    const s = await cashfree.fetchStatus("nope");
    assert.equal(s.success, false);
    assert.equal(s.pending, false);
    assert.equal(s.state, "UNKNOWN");
  });
});

// ── refunds ────────────────────────────────────────────────────────────────

test("the merchant refund id is the idempotency key and is sent verbatim", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ refund_status: "PENDING", cf_refund_id: "cfr_9" }));
    await cashfree.refundPayment({
      merchantRefundId: "RFB4242",
      originalMerchantOrderId: "MFB1",
      amountInRupees: 50,
    });
    assert.equal(calls[0].body.refund_id, "RFB4242");
    assert.match(calls[0].url, /\/orders\/MFB1\/refunds$/);
  });
});

test("SUCCESS, PENDING and ONHOLD are accepted; FAILED is not", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    for (const [state, expected] of [
      ["SUCCESS", true],
      ["PENDING", true],
      ["ONHOLD", true],
      ["FAILED", false],
      ["CANCELLED", false],
    ]) {
      queued.push(reply({ refund_status: state }));
      const r = await cashfree.refundPayment({
        merchantRefundId: "R1",
        originalMerchantOrderId: "MFB1",
        amountInRupees: 10,
      });
      assert.equal(r.accepted, expected, `${state} should be accepted=${expected}`);
    }
  });
});

// ── webhook signature ──────────────────────────────────────────────────────
// base64(HMAC-SHA256(timestamp + RAW body, client secret)). The raw body is the
// whole point: re-serialising the parsed JSON produces different bytes and the
// signature can never match.

const signed = (bodyObj, secret = "test-secret-key", ts = "1724500000000") => {
  const rawBody = JSON.stringify(bodyObj);
  const signature = crypto.createHmac("sha256", secret).update(`${ts}${rawBody}`).digest("base64");
  return {
    headers: { "x-webhook-signature": signature, "x-webhook-timestamp": ts },
    rawBody,
    body: JSON.parse(rawBody),
  };
};

test("a correctly signed webhook is accepted", () => {
  withEnv(CREDS, () => {
    const cashfree = load("../util/cashfree");
    assert.equal(cashfree.verifyCallbackAuth(signed({ type: "PAYMENT_SUCCESS_WEBHOOK" })), true);
  });
});

test("a tampered body is rejected", () => {
  withEnv(CREDS, () => {
    const cashfree = load("../util/cashfree");
    const req = signed({ amount: 100 });
    req.rawBody = JSON.stringify({ amount: 100000 });
    assert.equal(cashfree.verifyCallbackAuth(req), false);
  });
});

test("a signature from the wrong secret is rejected", () => {
  withEnv(CREDS, () => {
    const cashfree = load("../util/cashfree");
    assert.equal(cashfree.verifyCallbackAuth(signed({ a: 1 }, "someone-elses-secret")), false);
  });
});

test("replaying a body under a different timestamp is rejected", () => {
  withEnv(CREDS, () => {
    const cashfree = load("../util/cashfree");
    const req = signed({ a: 1 });
    req.headers["x-webhook-timestamp"] = "1724599999999";
    assert.equal(cashfree.verifyCallbackAuth(req), false);
  });
});

test("a missing rawBody refuses rather than guessing from req.body", () => {
  withEnv(CREDS, () => {
    const cashfree = load("../util/cashfree");
    const req = signed({ a: 1 });
    delete req.rawBody;
    assert.equal(cashfree.verifyCallbackAuth(req), false);
  });
});

test("missing headers are rejected, and nothing throws", () => {
  withEnv(CREDS, () => {
    const cashfree = load("../util/cashfree");
    assert.equal(cashfree.verifyCallbackAuth({}), false);
    assert.equal(cashfree.verifyCallbackAuth({ headers: {}, rawBody: "" }), false);
    assert.equal(cashfree.verifyCallbackAuth(null), false);
  });
});

test("an unconfigured secret can never validate a webhook", () => {
  withEnv({ CASHFREE_CLIENT_ID: undefined, CASHFREE_CLIENT_SECRET: undefined }, () => {
    const cashfree = load("../util/cashfree");
    assert.equal(cashfree.verifyCallbackAuth(signed({ a: 1 }, "")), false);
  });
});

// ── webhook parsing ────────────────────────────────────────────────────────

test("the order id and state are read from the documented payload shape", () => {
  const cashfree = load("../util/cashfree");
  const parsed = cashfree.parseCallback({
    body: {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      data: {
        order: { order_id: "MFB123", order_amount: 250 },
        payment: { cf_payment_id: "5114933189368", payment_status: "SUCCESS" },
      },
    },
  });
  assert.deepEqual(parsed, { merchantOrderId: "MFB123", state: "SUCCESS" });
});

test("an unrecognised body returns null instead of throwing", () => {
  const cashfree = load("../util/cashfree");
  assert.equal(cashfree.parseCallback({ body: { hello: "world" } }), null);
  assert.equal(cashfree.parseCallback({}), null);
  assert.equal(cashfree.parseCallback(null), null);
});

// ── doorstep UPI QR ────────────────────────────────────────────────────────
// The response shape below is copied from a real sandbox call, not from the
// docs — the published example shows `data` as all-nulls, and an earlier guess
// at the field names read nothing and silently fell back to a checkout link.

const QR_RESPONSE = {
  action: "custom",
  cf_payment_id: "212506136597280",
  channel: "podQrCode",
  data: {
    url: null,
    payload: {
      link: "upi://pay?pa=cashfree@testbank&pn=Cashfree&tr=212506136597280&am=150.00&cu=INR",
      qrcode: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg",
    },
  },
};

test("the QR string is read from data.payload.link", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFBQ", payment_session_id: "sess" }));
    queued.push(reply(QR_RESPONSE));

    const qr = await cashfree.createUpiQr({
      merchantOrderId: "MFBQ",
      amountInRupees: 150,
      userId: 1,
      customer: { id: 1, phone: "9876543210" },
    });

    assert.ok(qr, "a QR should be produced");
    assert.match(qr.qrString, /^upi:\/\/pay\?/);
    assert.equal(qr.channel, "podQrCode");
    assert.equal(qr.providerRef, "212506136597280");
  });
});

test("the rendered image is returned separately and is never the QR string", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFBQ", payment_session_id: "sess" }));
    queued.push(reply(QR_RESPONSE));
    const qr = await cashfree.createUpiQr({ merchantOrderId: "MFBQ", amountInRupees: 150, userId: 1 });
    assert.match(qr.qrImageBase64, /^data:image\/png;base64,/);
    assert.notEqual(qr.qrString, qr.qrImageBase64, "a data URI must never be used as the payload");
  });
});

test("podQrCode is tried first, and qrcode only as a fallback", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFBQ", payment_session_id: "sess" }));
    queued.push(reply({ message: "channel not enabled" }, 400));
    queued.push(reply({ ...QR_RESPONSE, channel: "qrcode" }));

    const qr = await cashfree.createUpiQr({ merchantOrderId: "MFBQ", amountInRupees: 150, userId: 1 });
    assert.equal(qr.channel, "qrcode", "should have fallen through to the second channel");
    assert.equal(JSON.parse(JSON.stringify(calls[1].body)).payment_method.upi.channel, "podQrCode");
    assert.equal(JSON.parse(JSON.stringify(calls[2].body)).payment_method.upi.channel, "qrcode");
  });
});

test("no usable payload returns null so the caller falls back to a link", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFBQ", payment_session_id: "sess" }));
    // The all-nulls shape the published docs show.
    queued.push(reply({ action: "custom", data: { url: null, payload: null } }));
    queued.push(reply({ action: "custom", data: { url: null, payload: null } }));
    const qr = await cashfree.createUpiQr({ merchantOrderId: "MFBQ", amountInRupees: 150, userId: 1 });
    assert.equal(qr, null);
  });
});

test("an S2S refusal on every channel returns null rather than throwing", async () => {
  await withEnv(CREDS, async () => {
    const cashfree = load("../util/cashfree");
    queued.push(reply({ order_id: "MFBQ", payment_session_id: "sess" }));
    queued.push(reply({ code: "request_failed", message: "S2S not enabled" }, 403));
    queued.push(reply({ code: "request_failed", message: "S2S not enabled" }, 403));
    const qr = await cashfree.createUpiQr({ merchantOrderId: "MFBQ", amountInRupees: 150, userId: 1 });
    assert.equal(qr, null, "a doorstep must degrade, never throw");
  });
});
