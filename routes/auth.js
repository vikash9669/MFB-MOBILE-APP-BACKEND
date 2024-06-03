const express = require("express");

const authController = require("../controllers/auth");

const router = express.Router();

router.post("/get-otp", authController.getOtp);

module.exports = router;
