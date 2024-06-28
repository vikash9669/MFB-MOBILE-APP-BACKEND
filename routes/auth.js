const express = require("express");

const authController = require("../controllers/auth");

const router = express.Router();

router.post("/get-otp", authController.getOtp);
router.post("/verify-otp", authController.verifyOtp);
router.put('/update/:user_id', authController.updateUser);

module.exports = router;
