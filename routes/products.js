const express = require("express");

const productController = require("../controllers/products");

const router = express.Router();

router.get("/restaurant", productController.getRestaurantsList);

router.get("/menu", productController.getMenu);

router.get(
  "/restaurant/:restaurantId",
  productController.getRestaurantDetailsByRestaurantId
);

router.get("/menu/:businessId", productController.getBusinessByMenuId);

router.get("/products", productController.getProducts);

module.exports = router;
