const express = require("express");
const addressController = require("../controllers/address");
const { verifyToken } = require("../middlewares/verifyToken");

const router = express.Router();

router.post("/address", verifyToken, addressController.createAddress);

router.get("/address", verifyToken, addressController.findAllByUser);

router.put(
  "/address/:delivery_id",
  verifyToken,
  addressController.updateAddress
);

router.delete(
  "/address/:delivery_id",
  verifyToken,
  addressController.deleteAddress
);

router.get("/locations", verifyToken, addressController.getAllLocations);

module.exports = router;
