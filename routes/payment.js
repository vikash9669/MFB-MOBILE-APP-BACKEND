const express = require("express");
const paymentController = require("../controllers/payment");

const router = express.Router();

// PhonePe's server-to-server callback. Deliberately unauthenticated — PhonePe
// has no JWT. Trust comes from the X-VERIFY signature, checked in the
// controller against the salt key.
router.post("/phonepe/callback", paymentController.phonepeCallback);

// The offline Dynamic QR product's callback. Separate endpoint because DQR
// signs with X-VERIFY while PG v2 uses an Authorization credential — one
// handler accepting either would weaken both. This is the URL to put in
// PHONEPE_DQR_CALLBACK_URL.
router.post("/phonepe/qr-callback", paymentController.phonepeQrCallback);

module.exports = router;
