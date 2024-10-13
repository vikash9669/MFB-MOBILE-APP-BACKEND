const { Banner } = require("../models");

const getBannersList = async (req, res) => {
  try {
    const banners = await Banner.findAll();
    res.json(banners);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = { getBannersList };
