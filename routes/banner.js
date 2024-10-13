const express = require("express");
const { getBannersList } = require("../controllers/banner");

const router = express.Router();

router.get("/", getBannersList);

module.exports = router;
