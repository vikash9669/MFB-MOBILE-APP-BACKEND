const express = require("express");

const orderController = require("../controllers/userdetails");
const userController = require("../controllers/user");
const { verifyToken } = require("../middlewares/verifyToken");

const router = express.Router();

router.get("/", verifyToken, userController.getUser);

router.get(
  "/orders/:customer_id",
  verifyToken,
  orderController.getOrdersByCustomerId
);

router.post("/createorder", orderController.createOrder);

module.exports = router;
