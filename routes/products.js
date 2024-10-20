const express = require("express");

const productController = require("../controllers/products");
const orderController = require("../controllers/order");

const router = express.Router();

router.get("/restaurant", productController.getRestaurantsList);

router.get("/menu", productController.getMenu);

router.get(
  "/restaurant/:restaurantId",
  productController.getRestaurantDetailsByRestaurantId
);

router.get("/menu/:businessId", productController.getBusinessByMenuId);

router.get("/products", productController.getProducts);

router.post("/coupon", orderController.getCouponCodeDiscountDetails);

module.exports = router;
