const test = require("node:test");
const assert = require("node:assert");

// Two settings whose DEFAULT is the whole point.
//
// Both used to fail open, and both failed silently — nothing logged, nothing
// threw, the damage only visible by looking at a rider's wallet or at a
// notification that arrived with no picture. A test is cheap insurance against
// either default being flipped back by someone who reads the code and assumes
// the permissive branch was deliberate.

// ── DELIVERY_DEMO ────────────────────────────────────────────────────
//
// Seeds fabricated orders, earnings and a pre-approved KYC status onto a
// partner's first login, and bypasses the onboarding gate doing it. The old
// gate was `=== "false"`, so every spelling of "no" except that exact one
// turned demo data ON for real riders.

function withDemo(value, fn) {
  const { demoEnabled } = require("../util/deliveryDemo");
  const had = "DELIVERY_DEMO" in process.env;
  const prev = process.env.DELIVERY_DEMO;
  if (value === undefined) delete process.env.DELIVERY_DEMO;
  else process.env.DELIVERY_DEMO = value;
  try {
    return fn(demoEnabled);
  } finally {
    if (had) process.env.DELIVERY_DEMO = prev;
    else delete process.env.DELIVERY_DEMO;
  }
}

test("demo data is off unless someone deliberately asked for it", () => {
  // The case that matters: a deploy that never sets the variable.
  withDemo(undefined, enabled => assert.strictEqual(enabled(), false));

  // Every plausible way of writing "no", including the ones the old
  // `!== "false"` gate treated as yes.
  for (const off of ["false", "False", "FALSE", "0", "no", "off", ""]) {
    withDemo(off, enabled =>
      assert.strictEqual(enabled(), false, `DELIVERY_DEMO=${JSON.stringify(off)} must not seed`),
    );
  }
});

test("demo data still turns on for the dev who wants it", () => {
  for (const on of ["true", "TRUE", "True", " true "]) {
    withDemo(on, enabled =>
      assert.strictEqual(enabled(), true, `DELIVERY_DEMO=${JSON.stringify(on)} should seed`),
    );
  }
});

// ── ASSETS_BASE_URL ──────────────────────────────────────────────────
//
// FCM fetches notification.image from Google's servers, not from the device,
// so the URL has to be reachable from the public internet. An unreachable one
// is not an error: FCM drops the image and delivers the notification without
// it. The old default was http://localhost:8091, which meant every deployment
// that hadn't set the variable sent pictureless notifications and said nothing.

test("an unset ASSETS_BASE_URL still produces a fetchable https image URL", () => {
  const had = "ASSETS_BASE_URL" in process.env;
  const prev = process.env.ASSETS_BASE_URL;
  delete process.env.ASSETS_BASE_URL;
  delete require.cache[require.resolve("../util/assetUrl")];
  try {
    const { assetUrl } = require("../util/assetUrl");
    const url = assetUrl("vendors", "vendor-77");

    // Not localhost, and not this API — which serves no static assets at all.
    assert.doesNotMatch(url, /localhost|127\.0\.0\.1|onrender\.com/);
    assert.match(url, /^https:\/\//, "FCM will not fetch a plaintext URL");
    assert.strictEqual(url, "https://www.myfirstbite.in/assets/uploads/vendors/webp/vendor-77.webp");

    // An already-suffixed name must not gain a second .webp.
    assert.strictEqual(
      assetUrl("products", "paneer.webp"),
      "https://www.myfirstbite.in/assets/uploads/products/webp/paneer.webp",
    );

    // No image is still no image — notifyUser omits the field rather than
    // sending a URL that 404s.
    assert.strictEqual(assetUrl("vendors", null), null);
  } finally {
    if (had) process.env.ASSETS_BASE_URL = prev;
    delete require.cache[require.resolve("../util/assetUrl")];
  }
});

test("ASSETS_BASE_URL still overrides, trailing slash and all", () => {
  const had = "ASSETS_BASE_URL" in process.env;
  const prev = process.env.ASSETS_BASE_URL;
  process.env.ASSETS_BASE_URL = "https://staging.example.com/assets/uploads/";
  delete require.cache[require.resolve("../util/assetUrl")];
  try {
    const { assetUrl } = require("../util/assetUrl");
    assert.strictEqual(
      assetUrl("vendors", "v1"),
      "https://staging.example.com/assets/uploads/vendors/webp/v1.webp",
    );
  } finally {
    if (had) process.env.ASSETS_BASE_URL = prev;
    else delete process.env.ASSETS_BASE_URL;
    delete require.cache[require.resolve("../util/assetUrl")];
  }
});
