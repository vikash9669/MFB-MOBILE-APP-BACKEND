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
//
// with the filename (no extension) stored in the DB — store_products.product_image
// and store_products_images.image_name. Those directories are already served by
// the PHP host on :8091 and by www.myfirstbite.in in production, so writing here
// keeps every existing image URL working.
//
// WebP only, despite a jpg/ directory existing beside it. This was checked
// against the live host: legacy images resolve as .webp and the matching .jpg
// is a 404, so the PHP panel converted on upload and wrote one file. Every
// reader builds <kind>/webp/<name>.webp with no fallback, which is why
// util/imageConvert.js converts rather than storing the original format.
const { Product, User } = require("../../models");
// Where the bytes go. The backend and the PHP host do not share a filesystem
// once deployed, which is exactly the case this used to get silently wrong —
// see util/uploadStore.js.
const uploadStore = require("../../util/uploadStore");
// Every upload becomes WebP before it is stored — see util/imageConvert.js.
const imageConvert = require("../../util/imageConvert");

// The kinds the PHP app uses; anything else is rejected so a request can't
// write outside these directories.
const KINDS = ["products", "menu", "users", "vendors", "banners", "cuisiness", "promos"];

const MAX_BYTES = 4 * 1024 * 1024;

// Everything is stored as WebP, whatever was uploaded — see util/imageConvert.js.
// This used to pick the directory from the source mime, which sent every JPEG
// and PNG to <kind>/jpg/<name>.jpg, a location no consumer has ever read from.
const STORED_EXT = "webp";

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
    const mime = match[1].toLowerCase();
    if (!imageConvert.isAccepted(mime)) {
      return res.status(415).json({ message: "Only JPEG, PNG or WebP images are accepted" });
    }

    const source = Buffer.from(match[2], "base64");
    // Checked against the UPLOAD, not the converted result: the limit exists to
    // bound what a caller may send, and WebP is usually smaller anyway.
    if (source.length > MAX_BYTES) {
      return res.status(413).json({ message: "Image must be 4 MB or smaller" });
    }

    // Always WebP, whatever arrived. Readers build <kind>/webp/<name>.webp and
    // have no fallback, so anything else is stored where nothing can find it.
    const buffer = await imageConvert.toWebp(source, mime);

    // Stored without an extension in the DB, exactly as the PHP app does — the
    // consumer appends /webp/<name>.webp.
    const base = `${safeName(filename)}_${Date.now().toString().slice(-6)}`;
    const { path: relative } = await uploadStore.putImage({
      kind,
      ext: STORED_EXT,
      base,
      buffer,
    });

    res.status(201).json({
      message: "Image uploaded",
      image_name: base,
      kind,
      // Relative to whatever serves the PHP assets directory.
      path: relative,
    });
  } catch (err) {
    // Not an image we can read, or conversion is unavailable. Either way the
    // caller should be told plainly rather than shown "Upload failed".
    if (err.unprocessable) {
      console.log("MFB-error-logs ~ upload ~ unprocessable:", err.message);
      return res.status(422).json({ message: err.message });
    }
    // A 201 for a file that went nowhere is what made the original bug
    // invisible: the panel showed success and the image was already lost. Say
    // plainly that storage is unavailable so the caller can keep the artwork
    // and try again once it is configured.
    if (err.unavailable) {
      console.log("MFB-error-logs ~ upload ~ refused:", err.message);
      return res.status(503).json({ message: err.message });
    }
    // A storage failure names what to change. This route is admin-only, so the
    // detail goes to the panel rather than making someone read server logs to
    // learn that a password is wrong. The underlying error is logged in full.
    if (err.storageFailure) {
      console.log("MFB-error-logs ~ upload ~ storage:", err.message, "~ cause:", err.cause?.message);
      return res.status(502).json({ message: err.message });
    }
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

    const removed = await uploadStore.removeImage({ kind, base });
    res.json({ message: removed ? "Image removed" : "Nothing to remove", removed });
  } catch (err) {
    if (err.unavailable) {
      console.log("MFB-error-logs ~ remove image ~ refused:", err.message);
      return res.status(503).json({ message: err.message });
    }
    if (err.storageFailure) {
      console.log("MFB-error-logs ~ remove image ~ storage:", err.message);
      return res.status(502).json({ message: err.message });
    }
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

// UPLOAD_ROOT is deliberately no longer exported: the destination may be an FTP
// host, so a single local path is not the answer any more. util/uploadStore.js
// owns it, and describe() is what to ask.
exports.KINDS = KINDS;
