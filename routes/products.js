const express = require("express");

const productController = require("../controllers/products");

const router = express.Router();

router.get("/restaurant", productController.getMenuForBusinesses);

router.get('/restaurant/:restaurantId', productController.getRestaurantDetailsByRestaurantId);


router.get("/menu", productController.getMenu);
router.get('/menu/:businessId', productController.getBusinessByMenuId);

router.get("/products", productController.getProducts);

// router.post("/createorder", productController.createOrder)
// router.get('/user/:userId/orders', productController.getUserOrders);


module.exports = router;