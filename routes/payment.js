const express = require("express");
const paymentController = require("../controllers/payment");

const router = express.Router();

// The gateway's server-to-server callback. Deliberately unauthenticated — no
// gateway carries our JWT. Trust comes from the signature: Cashfree sends an
// HMAC over the raw bytes, which the driver verifies. See util/gateway.js.
//
// These paths used to have /phonepe/* aliases alongside them, kept because that
// spelling was registered in the PhonePe dashboard. PhonePe has been removed,
// and nothing posts there any more — the backend names the callback itself on
// every order it creates (notifyUrl in controllers/payment.js), so the URL a
// gateway uses comes from us rather than from a dashboard field somebody set
// once.
router.post("/callback", paymentController.paymentCallback);

// Doorstep QR settlements. Kept as its own endpoint even though Cashfree sends
// QR money through the ordinary payment webhook, because the two carry
// different consequences — a QR settlement closes a rider's cash collection —
// and a caller that wants only one should not have to filter the other out.
router.post("/qr-callback", paymentController.qrCallback);

module.exports = router;
