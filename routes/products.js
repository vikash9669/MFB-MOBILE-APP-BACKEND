const express = require("express");

const productController = require("../controllers/products");
const orderController = require("../controllers/order");

const storefront = require("../controllers/storefront");

const router = express.Router();

router.get("/restaurant", productController.getRestaurantsList);

router.get("/menu", productController.getMenu);

router.get(
  "/restaurant/:restaurantId",
  productController.getRestaurantDetailsByRestaurantId
);

router.get("/menu/:businessId", productController.getBusinessByMenuId);

// Web storefront search (Pages::Search in the PHP app).
router.get("/search", storefront.searchProducts);
router.get("/products", productController.getProducts);

router.post("/coupon", orderController.getCouponCodeDiscountDetails);

module.exports = router;
