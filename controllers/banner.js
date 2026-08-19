const { Banner } = require("../models");

// GET /banners — the homepage carousel, read by the web storefront and the
// customer app.
//
// The legacy PHP storefront ran `SELECT * FROM store_banners ORDER BY
// banner_position` with no status check (store/controllers/Pages.php), so the
// admin panel's Publish/Hide toggle wrote banner_status and nothing ever read
// it — hiding a banner left it on the homepage. The toggle is real (PUT
// /admin/banners/:id) and the admin list reports "Live"/"Hidden", so the filter
// belongs here rather than in each client: the web storefront and the mobile
// app both render whatever this returns.
const getBannersList = async (req, res) => {
  try {
    const banners = await Banner.findAll({
      where: { banner_status: 1 },
      // Same ordering the PHP storefront and the admin list use.
      order: [
        ["banner_position", "ASC"],
        ["banner_id", "DESC"],
      ],
    });
    res.json(banners);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = { getBannersList };
