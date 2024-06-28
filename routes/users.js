const express = require("express");
const orderController = require("../controllers/order");
const userController = require("../controllers/user");
const { verifyToken } = require("../middlewares/verifyToken");
const router = express.Router();

router.get("/", verifyToken, userController.getUser);

router.get("/orders", verifyToken, orderController.getOrdersByCustomerId);

router.post("/create-order", verifyToken, orderController.createOrder);

module.exports = router;
