const test = require("node:test");
const assert = require("node:assert");

// Doorstep collection: classifying what the gateway handed back.
//
// Preserved from test/dqr.test.js, which was deleted with the PhonePe DQR
// client. This assertion was never about PhonePe — it is about what the rider's
// screen promises the customer — so it outlives the provider that prompted it.

test("a upi:// payload is recognised, a checkout URL is not", () => {
  // This classification decides what CollectPaymentScreen tells the rider to
  // say. A real upi:// intent opens the customer's UPI app with the amount
  // already filled in; anything else opens a web page and needs different
  // words.
  const { isUpiPayload } = require("../util/codCollection");

  assert.equal(isUpiPayload("upi://pay?pa=x@ybl&am=190.00"), true);
  assert.equal(isUpiPayload("UPI://pay?pa=x@ybl"), true, "scheme is case-insensitive");
  assert.equal(isUpiPayload("https://example.test/transact/v3?token=x"), false);
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
