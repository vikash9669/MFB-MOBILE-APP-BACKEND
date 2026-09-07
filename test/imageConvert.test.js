const test = require("node:test");
const assert = require("node:assert");

const imageConvert = require("../util/imageConvert");

// Uploads are converted to WebP because every reader assumes they already are.
//
// The panel, the storefront, both mobile apps and util/assetUrl.js all build
// exactly one URL: <base>/<kind>/webp/<name>.webp. Nothing looks in jpg/. So a
// JPEG or PNG stored in its own format was written perfectly and could not be
// reached by any URL the system knows how to build — a 201, a database row, and
// a permanent 404. Verified in production: an uploaded .jpg returned 200 at
// banners/jpg/... while the banners/webp/... the panel asked for was a 404.

/** The first bytes of a WebP file: "RIFF" .... "WEBP". */
const isWebp = (buf) =>
  buf.length > 12 &&
  buf.subarray(0, 4).toString("ascii") === "RIFF" &&
  buf.subarray(8, 12).toString("ascii") === "WEBP";

/** A real, tiny image in the requested format, built with sharp itself. */
async function sample(format) {
  const sharp = require("sharp");
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 60 } },
  })
    [format]()
    .toBuffer();
}

test("a JPEG upload is stored as WebP, not as a jpg nobody reads", async () => {
  const out = await imageConvert.toWebp(await sample("jpeg"), "image/jpeg");
  assert.ok(isWebp(out), "converted bytes must actually be WebP");
});

test("a PNG upload is converted too", async () => {
  // PNG was the worst case: the old mapping sent image/png to the "jpg"
  // directory, so the stored file was neither a real jpg nor reachable.
  const out = await imageConvert.toWebp(await sample("png"), "image/png");
  assert.ok(isWebp(out), "converted bytes must actually be WebP");
});

test("an image that is already WebP is passed through untouched", async () => {
  // Re-encoding is lossy. A banner uploaded twice would degrade each time for
  // no benefit, so identity here is a real requirement, not an optimisation.
  const original = await sample("webp");
  const out = await imageConvert.toWebp(original, "image/webp");
  assert.strictEqual(out, original, "the same buffer should come back");
});

test("the mime check accepts what the panel offers and nothing else", () => {
  for (const ok of ["image/jpeg", "image/jpg", "image/png", "image/webp", "IMAGE/PNG"]) {
    assert.strictEqual(imageConvert.isAccepted(ok), true, `${ok} should be accepted`);
  }
  for (const bad of ["image/gif", "image/svg+xml", "application/pdf", "text/html", "", null]) {
    assert.strictEqual(imageConvert.isAccepted(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test("a file that only claims to be an image is refused, not stored", async () => {
  // Storing this would put an unreadable file at a URL the storefront renders.
  await assert.rejects(
    () => imageConvert.toWebp(Buffer.from("this is not an image"), "image/png"),
    (err) => {
      assert.strictEqual(err.unprocessable, true, "the route needs this to answer 422");
      assert.match(err.message, /could not be read as an image/i);
      return true;
    },
  );
});

test("a truncated image is refused rather than half-converted", async () => {
  const whole = await sample("png");
  await assert.rejects(
    () => imageConvert.toWebp(whole.subarray(0, 20), "image/png"),
    (err) => err.unprocessable === true,
  );
});

test("conversion actually re-encodes rather than renaming", async () => {
  // A JPEG passed through unchanged would still be a JPEG sitting at a .webp
  // URL. Browsers sniff, so it might even render — and then break in whatever
  // does not. Assert the bytes changed format, not just the extension.
  const jpeg = await sample("jpeg");
  const out = await imageConvert.toWebp(jpeg, "image/jpeg");
  assert.ok(!isWebp(jpeg), "the fixture must start as a non-WebP");
  assert.ok(isWebp(out), "the result must be WebP");
});
