const express = require("express");
const orderController = require("../controllers/order");
const userController = require("../controllers/user");
const authController = require("../controllers/auth");
const { verifyToken } = require("../middlewares/verifyToken");
const router = express.Router();

router.get("/", verifyToken, userController.getUser);

router.post("/", verifyToken, authController.updateUser);

router.get("/orders", verifyToken, orderController.getOrdersByCustomerId);

router.post("/create-order", verifyToken, orderController.createOrder);

router.get('/active-orders', verifyToken, orderController.getActiveOrders)

module.exports = router;
