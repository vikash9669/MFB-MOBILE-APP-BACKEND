// Image upload — the working replacement for administration/Ajax::uploadFiles.
//
// That PHP function was DEAD: its second line was `echo "<pre>"; print_r($_POST);
// exit;`, and it wrote to `vehicles` / `vehicles_files`, tables copy-pasted from
// another project that do not exist in this schema. Nothing in this panel could
// ever upload through it.
//
// The storage that IS in use (Products_Model, Settings::Products and the mobile
// apps' ASSETS_BASE_URL) is the filesystem under the PHP app's public assets:
//
//   MFB_PHP_ADMIN_PANEL/admin/assets/uploads/<kind>/webp/<name>.webp
//                                            /<kind>/jpg/<name>.jpg
//
// with the filename (no extension) stored in the DB — store_products.product_image
// and store_products_images.image_name. Those directories are already served by
// the PHP host on :8091 and by www.myfirstbite.in in production, so writing here
// keeps every existing image URL working.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Product, User } = require("../../models");

// Where the PHP app keeps its uploads. Configurable because the backend and the
// PHP host may not share a filesystem once deployed.
const UPLOAD_ROOT =
  process.env.UPLOADS_ROOT ||
  path.resolve(__dirname, "../../../MFB_PHP_ADMIN_PANEL/admin/assets/uploads");

// The kinds the PHP app uses; anything else is rejected so a request can't
// write outside these directories.
const KINDS = ["products", "menu", "users", "vendors", "banners", "cuisiness", "promos"];

const MAX_BYTES = 4 * 1024 * 1024;
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "jpg",
  "image/webp": "webp",
};

/** Strips anything that could escape the upload directory. */
const safeName = (name) =>
  String(name || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 90) || `img_${Date.now()}`;

// POST /admin/uploads  { kind, filename, data }  — data is a base64 data URI.
// A data URI keeps this dependency-free (no multer) and matches how the mobile
// apps already post proof-of-delivery photos.
exports.upload = async (req, res) => {
  try {
    const { kind, filename, data } = req.body;
    if (!KINDS.includes(String(kind))) {
      return res.status(400).json({ message: `kind must be one of: ${KINDS.join(", ")}` });
    }
    if (!data || typeof data !== "string") {
      return res.status(400).json({ message: "No image supplied" });
    }

    const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(data);
    if (!match) {
      return res.status(400).json({ message: "Image must be a base64 data URI" });
    }
    const ext = MIME_EXT[match[1].toLowerCase()];
    if (!ext) {
      return res.status(415).json({ message: "Only JPEG, PNG or WebP images are accepted" });
    }

    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ message: "Image must be 4 MB or smaller" });
    }

    // Stored without an extension in the DB, exactly as the PHP app does — the
    // consumer appends /webp/<name>.webp or /jpg/<name>.jpg.
    const base = `${safeName(filename)}_${Date.now().toString().slice(-6)}`;
    const dir = path.join(UPLOAD_ROOT, kind, ext);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${base}.${ext}`), buffer);

    res.status(201).json({
      message: "Image uploaded",
      image_name: base,
      kind,
      // Relative to whatever serves the PHP assets directory.
      path: `${kind}/${ext}/${base}.${ext}`,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ upload ~ err:", err);
    res.status(500).json({ message: "Upload failed" });
  }
};

// DELETE /admin/uploads  { kind, image_name } — Ajax::removeImage.
// Removes both renditions; a missing file is not an error, so the call is safe
// to retry.
exports.remove = async (req, res) => {
  try {
    const { kind, image_name } = req.body;
    if (!KINDS.includes(String(kind))) {
      return res.status(400).json({ message: "Unknown image kind" });
    }
    const base = safeName(image_name);
    if (!base) return res.status(400).json({ message: "No image named" });

    let removed = 0;
    for (const ext of ["webp", "jpg"]) {
      const file = path.join(UPLOAD_ROOT, kind, ext, `${base}.${ext}`);
      try {
        await fs.unlink(file);
        removed += 1;
      } catch {
        // Already gone — nothing to do.
      }
    }
    res.json({ message: removed ? "Image removed" : "Nothing to remove", removed });
  } catch (err) {
    console.log("MFB-error-logs ~ remove image ~ err:", err);
    res.status(500).json({ message: "Failed to remove image" });
  }
};

// PUT /admin/uploads/attach — points a record at an uploaded image.
exports.attach = async (req, res) => {
  try {
    const { target, id, image_name } = req.body;
    if (!image_name) return res.status(400).json({ message: "No image named" });

    if (target === "product") {
      const product = await Product.findByPk(id);
      if (product == null) return res.status(404).json({ message: "Product not found" });
      await product.update({ product_image: safeName(image_name) });
      return res.json({ message: "Product image updated" });
    }
    if (target === "user") {
      const user = await User.findByPk(id);
      if (user == null) return res.status(404).json({ message: "User not found" });
      await user.update({ user_image: safeName(image_name) });
      return res.json({ message: "Profile image updated" });
    }
    return res.status(400).json({ message: "target must be 'product' or 'user'" });
  } catch (err) {
    console.log("MFB-error-logs ~ attach image ~ err:", err);
    res.status(500).json({ message: "Failed to attach image" });
  }
};

exports.UPLOAD_ROOT = UPLOAD_ROOT;
exports.KINDS = KINDS;
