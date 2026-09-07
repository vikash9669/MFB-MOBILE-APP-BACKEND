const test = require("node:test");
const assert = require("node:assert");

const { initiatePayment } = require("../controllers/payment");

// Which payment methods /user/payment/initiate will accept.
//
// The checkout screen now offers ONE online option and lets the gateway's own
// screen pick the instrument, so the app sends ONLINE. The interesting part is
// what happens to the apps that DON'T send it: this backend deploys the instant
// it is pushed, while installed copies of the app update whenever each customer
// gets round to it. UPI and CARD must keep working or online payment breaks for
// everyone who has not yet updated — a failure that would look, from the phone,
// exactly like the gateway being down.

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const initiateWith = async (method) => {
  const res = fakeRes();
  await initiatePayment(
    { user: { user_id: 1 }, body: { method } },
    res
  );
  return res;
};

// The check runs before any database or gateway work, so "accepted" means the
// request got past this gate — not that it went on to succeed.
const rejectedForMethod = (res) =>
  res.statusCode === 400 && /Unsupported payment method/.test(res.body?.message ?? "");

test("ONLINE is accepted — what the current checkout sends", async () => {
  assert.strictEqual(rejectedForMethod(await initiateWith("ONLINE")), false);
});

test("UPI is still accepted, for app versions that have not updated", async () => {
  assert.strictEqual(rejectedForMethod(await initiateWith("UPI")), false);
});

test("CARD is still accepted, for app versions that have not updated", async () => {
  assert.strictEqual(rejectedForMethod(await initiateWith("CARD")), false);
});

test("the method is matched case-insensitively", async () => {
  assert.strictEqual(rejectedForMethod(await initiateWith("online")), false);
});

test("COD cannot be pushed through the online path", async () => {
  // COD orders are created by controllers/order.js and never touch a gateway.
  // Accepting it here would park a PENDING payment intent for an order nobody
  // is ever going to pay online.
  assert.strictEqual(rejectedForMethod(await initiateWith("COD")), true);
});

test("an unknown or missing method is refused", async () => {
  for (const method of ["BITCOIN", "", null, undefined]) {
    assert.strictEqual(
      rejectedForMethod(await initiateWith(method)),
      true,
      `${JSON.stringify(method)} should be refused`
    );
  }
});
