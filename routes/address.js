const express = require("express");
const addressController = require("../controllers/address");
const placesController = require("../controllers/places");
const { verifyToken } = require("../middlewares/verifyToken");
const { placesLookup } = require("../middlewares/rateLimit");

const router = express.Router();

// Google Places, proxied so the billable web-service key never leaves the
// server. Signed-in only, for the same reason — an open endpoint here is an
// open tab on someone else's Google bill. A token is not a spending limit
// though, so the calls are also capped per customer: one stolen token, or one
// app looping on a keystroke handler, should not be able to run up an invoice.
router.get("/places/autocomplete", verifyToken, placesLookup, placesController.autocomplete);
router.get("/places/details", verifyToken, placesLookup, placesController.details);
router.get("/places/reverse", verifyToken, placesLookup, placesController.reverse);

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
