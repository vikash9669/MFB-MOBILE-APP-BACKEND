// Every uploaded image becomes WebP, because every reader assumes it already is.
//
// THE BUG THIS EXISTS TO FIX
//
// controllers/admin/uploads.js chose a directory from the SOURCE mime type:
// a JPEG or PNG went to <kind>/jpg/<name>.jpg, a WebP to <kind>/webp/<name>.webp.
// But every consumer — the panel, the storefront, both mobile apps and
// util/assetUrl.js on this server — builds exactly one URL shape:
//
//     <base>/<kind>/webp/<name>.webp
//
// Nothing has ever looked in jpg/. So uploading a JPEG or PNG produced a file
// that was stored perfectly and could not be reached by any URL the system
// knows how to build: a 201, a database row, and a permanent 404.
//
// The PHP panel this replaced did not have the problem because it CONVERTED
// every upload to WebP and wrote a single .webp file — confirmed against the
// live host, where legacy images exist as .webp only and the matching .jpg is
// a 404. The Node rewrite dropped the conversion but kept the readers'
// assumption. This module restores it.
//
// Converting rather than teaching four codebases to try a second extension is
// deliberate: one of those codebases is a released mobile app that cannot be
// updated retroactively, and the URL shape it hardcodes has to keep working.
const WEBP_QUALITY = Number(process.env.UPLOAD_WEBP_QUALITY || 82);

/** Source formats accepted from the panel, mapped to what sharp reports. */
const ACCEPTED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/** Raised when the bytes are not an image we can convert. */
class UnprocessableImage extends Error {
  constructor(message) {
    super(message);
    this.name = "UnprocessableImage";
    this.unprocessable = true;
  }
}

const isAccepted = (mime) => ACCEPTED.has(String(mime || "").toLowerCase());

/**
 * Returns WebP bytes for any accepted input.
 *
 * An image that is ALREADY WebP is passed through untouched rather than
 * re-encoded: re-encoding is lossy, so a banner uploaded twice would degrade
 * each time for no benefit.
 */
async function toWebp(buffer, mime) {
  if (String(mime || "").toLowerCase() === "image/webp") {
    return buffer;
  }

  let sharp;
  try {
    sharp = require("sharp");
  } catch (err) {
    // Refuse rather than fall back to storing the original: a .jpg written
    // here is exactly the unreachable file this module exists to prevent.
    throw new UnprocessableImage(
      "Image conversion is unavailable on this server (sharp failed to load), " +
        `so the upload was refused rather than stored where nothing can read it: ${err.message}`
    );
  }

  try {
    return await sharp(buffer).webp({ quality: WEBP_QUALITY }).toBuffer();
  } catch (err) {
    // Truncated, corrupt, or a file that only claims to be an image.
    throw new UnprocessableImage(`That file could not be read as an image: ${err.message}`);
  }
}

module.exports = { toWebp, isAccepted, UnprocessableImage, ACCEPTED, WEBP_QUALITY };
