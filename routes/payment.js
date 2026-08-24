const express = require("express");
const paymentController = require("../controllers/payment");

const router = express.Router();

// The provider's server-to-server callback. Deliberately unauthenticated —
// no gateway carries our JWT. Trust comes from the signature, which the active
// driver checks in its own scheme: a dashboard credential (PhonePe PG), an
// X-VERIFY body checksum (PhonePe DQR), or an HMAC over the raw bytes
// (Cashfree). See util/gateway.js.
//
// Provider-neutral paths are the ones to configure from now on. The /phonepe/*
// spellings are kept because they are already registered in the PhonePe
// dashboard, and a webhook URL that quietly 404s is the worst kind of outage:
// the customer is charged and no order is ever created.
router.post("/callback", paymentController.paymentCallback);
router.post("/phonepe/callback", paymentController.paymentCallback);

// Doorstep QR settlements. Separate endpoint because PhonePe signs this
// product differently from its own checkout; on Cashfree both point at the
// same verification, since one webhook covers every payment.
router.post("/qr-callback", paymentController.qrCallback);
router.post("/phonepe/qr-callback", paymentController.qrCallback);

module.exports = router;
