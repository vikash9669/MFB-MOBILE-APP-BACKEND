// Banners — administration/Settings::Index and Settings_Model::Banners.
//
// The PHP screen listed store_banners and appended new ones through a multi-file
// upload. Here the image is uploaded first (POST /admin/uploads with
// kind="banners"), and the returned image_name is posted as banner_path — the
// same two-step the products and menu screens use, so one upload path serves
// every module.
const { Banner } = require("../../models");

const serialize = (b) => ({
  banner_id: b.banner_id,
  name: b.banner_name,
  title: b.banner_title,
  href: b.banner_href,
  path: b.banner_path,
  position: Number(b.banner_position),
  status: Number(b.banner_status),
});

// The positions the storefront renders. Kept as data so the panel can label
// them without hard-coding the same numbers in the React app.
const POSITIONS = [
  { value: 1, label: "Home — top carousel" },
  { value: 2, label: "Home — mid strip" },
  { value: 3, label: "Category page" },
  { value: 4, label: "Offers page" },
];

// GET /admin/banners
exports.list = async (req, res) => {
  try {
    const rows = await Banner.findAll({
      order: [
        ["banner_position", "ASC"],
        ["banner_id", "DESC"],
      ],
      raw: true,
    });
    res.json({ banners: rows.map(serialize), positions: POSITIONS });
  } catch (err) {
    console.log("MFB-error-logs ~ admin banners ~ err:", err);
    res.status(500).json({ message: "Failed to load banners" });
  }
};

// POST /admin/banners  { name, title, path, href, position, status }
exports.create = async (req, res) => {
  try {
    const { name, title, path } = req.body;
    if (!name || !title) {
      return res.status(400).json({ message: "Banner name and title are required" });
    }
    if (!path) {
      return res.status(400).json({ message: "Upload a banner image first" });
    }
    const created = await Banner.create({
      banner_name: String(name),
      banner_title: String(title),
      banner_path: String(path),
      banner_href: req.body.href || null,
      banner_position: Number(req.body.position) || 1,
      banner_status: req.body.status === undefined ? 1 : Number(req.body.status) ? 1 : 0,
    });
    res.status(201).json({ message: "Banner added", banner: serialize(created) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin create banner ~ err:", err);
    res.status(500).json({ message: "Failed to add banner" });
  }
};

// PUT /admin/banners/:id
exports.update = async (req, res) => {
  try {
    const banner = await Banner.findByPk(req.params.id);
    if (banner == null) {
      return res.status(404).json({ message: "Banner not found" });
    }
    const patch = {};
    if (req.body.name !== undefined) patch.banner_name = String(req.body.name);
    if (req.body.title !== undefined) patch.banner_title = String(req.body.title);
    if (req.body.path !== undefined) patch.banner_path = String(req.body.path);
    if (req.body.href !== undefined) patch.banner_href = req.body.href || null;
    if (req.body.position !== undefined) patch.banner_position = Number(req.body.position);
    if (req.body.status !== undefined) patch.banner_status = Number(req.body.status) ? 1 : 0;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }
    await banner.update(patch);
    res.json({ message: "Banner updated", banner: serialize(banner) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin update banner ~ err:", err);
    res.status(500).json({ message: "Failed to update banner" });
  }
};

// DELETE /admin/banners/:id
//
// A real delete, unlike Ajax::Delete's status flip: a banner is presentation,
// not a record anything else refers to, and the PHP list had no way to hide one
// permanently. The image file is left in place — POST /admin/uploads' delete
// handles that separately, and orphaned files are harmless.
exports.remove = async (req, res) => {
  try {
    const removed = await Banner.destroy({ where: { banner_id: req.params.id } });
    if (removed === 0) {
      return res.status(404).json({ message: "Banner not found" });
    }
    res.json({ message: "Banner removed" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin remove banner ~ err:", err);
    res.status(500).json({ message: "Failed to remove banner" });
  }
};
