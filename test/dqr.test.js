const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

// Unit tests for the offline Dynamic QR client and the choice between a real
// UPI QR and the hosted-checkout fallback. No network: everything here is
// checksum construction, config gating and payload classification, which is
// where the mistakes that cost a payment at a doorstep actually live.

const SALT = "test-salt-key";
const load = () => {
  delete require.cache[require.resolve("../util/phonepeDqr")];
  return require("../util/phonepeDqr");
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

const CONFIGURED = {
  PHONEPE_MERCHANT_ID: "MERCHANTUAT",
  PHONEPE_DQR_SALT_KEY: SALT,
  PHONEPE_DQR_SALT_INDEX: "1",
  PHONEPE_DQR_STORE_ID: "STORE1",
};

test("isConfigured is false until salt key AND store id are both present", () => {
  const dqr = load();

  withEnv({ ...CONFIGURED, PHONEPE_DQR_SALT_KEY: undefined }, () => {
    assert.equal(dqr.isConfigured(), false, "no salt key must read as off");
  });

  // storeId is as load-bearing as the salt key: PhonePe rejects an init
  // without it, so a half-filled config must degrade to the hosted checkout
  // rather than fail per-order at a doorstep.
  withEnv({ ...CONFIGURED, PHONEPE_DQR_STORE_ID: undefined }, () => {
    assert.equal(dqr.isConfigured(), false, "no store id must read as off");
  });

  withEnv(CONFIGURED, () => {
    assert.equal(dqr.isConfigured(), true);
  });
});

test("POST checksum is SHA256(body + path + salt) ### index", () => {
  const dqr = load();
  const body = Buffer.from(JSON.stringify({ a: 1 })).toString("base64");
  const path = "/v3/qr/init";

  const expected =
    crypto.createHash("sha256").update(`${body}${path}${SALT}`).digest("hex") + "###1";

  assert.equal(dqr._checksum(body, path, SALT, "1"), expected);
});

test("the path is inside the digest, so a checksum is not portable between endpoints", () => {
  const dqr = load();
  const body = "Zm9v";
  assert.notEqual(
    dqr._checksum(body, "/v3/qr/init", SALT, "1"),
    dqr._checksum(body, "/v3/transaction/M/T/status", SALT, "1")
  );
});

test("GET checksum omits the body", () => {
  const dqr = load();
  const path = "/v3/transaction/MERCHANTUAT/TX1/status";
  const expected =
    crypto.createHash("sha256").update(`${path}${SALT}`).digest("hex") + "###1";
  assert.equal(dqr._checksumForPath(path, SALT, "1"), expected);
});

test("transaction ids are coerced into PhonePe's charset and length", () => {
  const dqr = load();

  // Docs: alphanumerics plus hyphen and underscore, 35 max. A rejected
  // character here costs a payment at a doorstep.
  assert.equal(dqr._safeTransactionId("MFBC/178#649$958@0276"), "MFBC1786499580276");
  assert.equal(dqr._safeTransactionId("keep-these_ok123"), "keep-these_ok123");
  assert.equal(dqr._safeTransactionId("x".repeat(80)).length, 35);
});

test("callback verification rejects a tampered body and accepts a real one", () => {
  const dqr = load();
  withEnv(CONFIGURED, () => {
    const body = Buffer.from(JSON.stringify({ data: { transactionId: "TX1" } })).toString(
      "base64"
    );
    const good =
      crypto.createHash("sha256").update(`${body}${SALT}`).digest("hex") + "###1";

    assert.equal(dqr.verifyCallback(body, good), true);
    assert.equal(dqr.verifyCallback(body, "deadbeef###1"), false, "wrong digest");
    assert.equal(dqr.verifyCallback("bm90LXRoZS1ib2R5", good), false, "body swapped");
    assert.equal(dqr.verifyCallback(body, undefined), false, "missing header");
    assert.equal(dqr.verifyCallback(undefined, good), false, "missing body");
  });
});

test("callback verification is off when DQR is not configured", () => {
  const dqr = load();
  // Otherwise an unconfigured deployment would compute checksums against an
  // empty salt and could be talked into accepting one.
  withEnv({ ...CONFIGURED, PHONEPE_DQR_SALT_KEY: undefined }, () => {
    const body = "e30=";
    const digest = crypto.createHash("sha256").update(`${body}`).digest("hex") + "###1";
    assert.equal(dqr.verifyCallback(body, digest), false);
  });
});

test("decodeCallback returns null on rubbish rather than throwing", () => {
  const dqr = load();
  assert.equal(dqr.decodeCallback("not-base64-json"), null);
  assert.deepEqual(dqr.decodeCallback(Buffer.from('{"ok":1}').toString("base64")), { ok: 1 });
});

test("host follows PHONEPE_ENV", () => {
  const dqr = load();
  withEnv({ ...CONFIGURED, PHONEPE_ENV: "PROD" }, () => {
    assert.equal(dqr.config().host, "https://mercury-t2.phonepe.com");
  });
  withEnv({ ...CONFIGURED, PHONEPE_ENV: "UAT" }, () => {
    assert.equal(dqr.config().host, "https://mercury-uat.phonepe.com/enterprise-sandbox");
  });
});

test("a upi:// payload is recognised, a checkout URL is not", () => {
  // This classification decides which PhonePe product gets asked for status.
  // The two keep separate ledgers, so getting it wrong means asking about a
  // transaction that provider has never heard of and leaving paid money
  // looking unpaid for ever.
  const { isUpiPayload } = require("../util/codCollection");

  assert.equal(isUpiPayload("upi://pay?pa=x@ybl&am=190.00"), true);
  assert.equal(isUpiPayload("UPI://pay?pa=x@ybl"), true, "scheme is case-insensitive");
  assert.equal(isUpiPayload("https://mercury-uat.phonepe.com/transact/uat_v3?token=x"), false);
  assert.equal(isUpiPayload(null), false);
  assert.equal(isUpiPayload(""), false);

  // The one that mattered: Cashfree's sandbox answers the QR call with an
  // https simulator URL that CARRIES UPI fields (pa=, am=, cu=) but is not a
  // upi:// intent. Classifying it as a UPI code would have the rider telling
  // the customer "scan this with any UPI app, the amount is filled in" about a
  // link that opens a web page. Only the scheme decides.
  assert.equal(
    isUpiPayload(
      "https://payments-test.cashfree.com/pgbillpayuiapi/simulator/212506136597280" +
        "?pa=cashfree@testbank&pn=Cashfree&am=150.00&cu=INR"
    ),
    false,
    "UPI query params do not make an https link a UPI QR"
  );
});
