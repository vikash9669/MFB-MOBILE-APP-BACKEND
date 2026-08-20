const express = require("express");

const authController = require("../controllers/auth");
const { verifyToken } = require("../middlewares/verifyToken");
const { otpSendPerPhone, otpSendPerIp, otpVerify } = require("../middlewares/rateLimit");

const router = express.Router();

// Both send limiters apply: per phone so one handset cannot be SMS-bombed, per
// IP so one caller cannot spray thousands of numbers. Each send is a paid
// message, so every request counts here — not just the failed ones.
router.post("/get-otp", otpSendPerPhone, otpSendPerIp, authController.getOtp);
// Verify counts failures only, so a customer who types the code correctly is
// never nudged toward a lockout.
router.post("/verify-otp", otpVerify, authController.verifyOtp);
router.put("/update", verifyToken, authController.updateUser);

module.exports = router;
