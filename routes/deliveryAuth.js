const express = require("express");

const deliveryAuthController = require("../controllers/deliveryAuth");
const { verifyToken } = require("../middlewares/verifyToken");

const router = express.Router();

router.post("/get-otp", deliveryAuthController.getOtp);
router.post("/verify-otp", deliveryAuthController.verifyOtp);
router.post("/refresh", deliveryAuthController.refresh);
router.post("/logout", verifyToken, deliveryAuthController.logout);
router.put("/settings", verifyToken, deliveryAuthController.updateSettings);

module.exports = router;
