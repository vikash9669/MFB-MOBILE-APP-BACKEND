const express = require("express");

const deliveryAuthController = require("../controllers/deliveryAuth");
const { verifyToken } = require("../middlewares/verifyToken");
const {
  otpSendPerPhone,
  otpSendPerIp,
  otpVerify,
  tokenRefresh,
} = require("../middlewares/rateLimit");

const router = express.Router();

// Same caps as the customer app — see routes/auth.js. The buckets are shared
// between the two apps on purpose: they are the same phone number and the same
// SMS bill, so a caller cannot double their allowance by alternating endpoints.
router.post("/get-otp", otpSendPerPhone, otpSendPerIp, deliveryAuthController.getOtp);
router.post("/verify-otp", otpVerify, deliveryAuthController.verifyOtp);
router.post("/refresh", tokenRefresh, deliveryAuthController.refresh);
router.post("/logout", verifyToken, deliveryAuthController.logout);
router.put("/settings", verifyToken, deliveryAuthController.updateSettings);

module.exports = router;
