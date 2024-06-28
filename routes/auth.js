const express = require("express");

const authController = require("../controllers/auth");
const { verifyToken } = require("../middlewares/verifyToken");

const router = express.Router();

router.post("/get-otp", authController.getOtp);
router.post("/verify-otp", authController.verifyOtp);
router.put("/update/:user_id", verifyToken, authController.updateUser);

module.exports = router;
