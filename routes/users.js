const express = require("express");

const orderController = require("../controllers/userdetails");

const router = express.Router();


router.get("/orders/:customer_id", orderController.getOrdersByCustomerId);

router.post("/createorder", orderController.createOrder)

module.exports = router;
