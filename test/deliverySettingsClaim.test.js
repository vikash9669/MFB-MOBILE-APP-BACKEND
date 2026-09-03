const test = require("node:test");
const assert = require("node:assert");

const {
  _normalizeSettings: normalizeSettings,
  _partnerClaims: partnerClaims,
} = require("../controllers/deliveryAuth");

// dp_settings is declared DataTypes.JSON on the model but the physical column
// is longtext, so mysql2 hands back a raw string that Sequelize never parses.
// The old code spread that string directly — `{ ...partner.dp_settings }` —
// which indexes it character by character into { "0": "{", "1": "\"", ... }.
// That object was written back to the column and spread again on the next
// save, so every settings update multiplied the stored value.
//
// It surfaced as an authentication failure rather than a settings failure:
// partnerClaims embeds settings in the access token, the bloated claim pushed
// the JWT past Node's 16KB max header size, and the truncated Authorization
// header came back as "jwt malformed" — a 403 on every authenticated request.

const KEYS = ["notifications", "location", "camera", "phone", "battery"];

/** The five booleans, all false. */
const allFalse = () => ({
  notifications: false,
  location: false,
  camera: false,
  phone: false,
  battery: false,
});

/** Reproduces one generation of the corruption: spread a string into an object. */
const charIndex = (str) => ({ ...str });

test("a plain object round-trips unchanged", () => {
  const settings = { ...allFalse(), notifications: true, location: true };
  assert.deepStrictEqual(normalizeSettings(settings), settings);
});

test("a JSON string is parsed rather than spread", () => {
  const settings = { ...allFalse(), camera: true };
  assert.deepStrictEqual(normalizeSettings(JSON.stringify(settings)), settings);
});

test("null and undefined fall back to all-false defaults", () => {
  assert.deepStrictEqual(normalizeSettings(null), allFalse());
  assert.deepStrictEqual(normalizeSettings(undefined), allFalse());
});

test("a char-indexed object is rebuilt into the original settings", () => {
  const settings = { ...allFalse(), battery: true };
  assert.deepStrictEqual(normalizeSettings(charIndex(JSON.stringify(settings))), settings);
});

test("repeated corruption generations are unwound, not compounded", () => {
  const settings = { ...allFalse(), phone: true };
  // Three successive saves under the old code: each one spread the previous
  // stringified generation into a fresh char-indexed object.
  let corrupted = JSON.stringify(settings);
  for (let i = 0; i < 3; i += 1) {
    corrupted = JSON.stringify(charIndex(corrupted));
  }
  assert.ok(corrupted.length > 2000, "fixture should be a genuinely bloated blob");
  assert.deepStrictEqual(normalizeSettings(corrupted), settings);
});

test("unknown keys are dropped, so the claim can never grow unbounded", () => {
  const result = normalizeSettings({ ...allFalse(), junk: "x".repeat(10_000) });
  assert.deepStrictEqual(Object.keys(result).sort(), [...KEYS].sort());
});

test("values are coerced to booleans", () => {
  const result = normalizeSettings({ notifications: 1, location: "yes", camera: 0 });
  assert.strictEqual(result.notifications, true);
  assert.strictEqual(result.location, true);
  assert.strictEqual(result.camera, false);
});

test("garbage that parses to a non-object falls back to defaults", () => {
  assert.deepStrictEqual(normalizeSettings("not json at all"), allFalse());
  assert.deepStrictEqual(normalizeSettings("42"), allFalse());
  assert.deepStrictEqual(normalizeSettings([1, 2, 3]), allFalse());
});

test("the access-token claim stays small even for a corrupted column", () => {
  let corrupted = JSON.stringify(allFalse());
  for (let i = 0; i < 4; i += 1) {
    corrupted = JSON.stringify(charIndex(corrupted));
  }

  const claims = partnerClaims({
    dp_id: 1,
    dp_name: "Test Rider",
    dp_email: "",
    dp_phone: "9999999999",
    dp_verification_status: "approved",
    dp_settings: corrupted,
  });

  // Comfortably inside Node's 16KB header limit, which the 17KB token that
  // prompted this fix was not.
  assert.ok(
    JSON.stringify(claims).length < 500,
    `claims should stay small, got ${JSON.stringify(claims).length} bytes`,
  );
  assert.deepStrictEqual(claims.settings, allFalse());
});
