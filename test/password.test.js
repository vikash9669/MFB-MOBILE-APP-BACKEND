const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { hash, matches, isDigest } = require("../util/password");

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

test("hash produces the same digest the PHP panel writes", () => {
  assert.strictEqual(hash("Admin@012"), md5("Admin@012"));
  assert.strictEqual(hash("Admin@012").length, 32);
});

test("a correct password unlocks a stored digest", () => {
  assert.ok(matches(md5("Admin@012"), "Admin@012"));
});

test("a wrong password does not", () => {
  assert.ok(!matches(md5("Admin@012"), "admin@012"));
  assert.ok(!matches(md5("Admin@012"), "Admin@0122"));
});

test("uppercase digests in the column still match", () => {
  assert.ok(matches(md5("Admin@012").toUpperCase(), "Admin@012"));
});

// The reason the raw branch is gated on shape rather than tried as a fallback.
test("submitting the stored digest itself is refused", () => {
  const stored = md5("Admin@012");
  assert.ok(!matches(stored, stored));
});

test("a blank column never matches, including a blank submission", () => {
  assert.ok(!matches("", ""));
  assert.ok(!matches("", "anything"));
  assert.ok(!matches(null, "anything"));
  assert.ok(!matches(md5("x"), ""));
});

test("plaintext development rows still compare raw", () => {
  assert.ok(matches("devpass", "devpass"));
  assert.ok(!matches("devpass", "wrong"));
});

test("isDigest recognises only 32-char hex", () => {
  assert.ok(isDigest(md5("x")));
  assert.ok(!isDigest("devpass"));
  assert.ok(!isDigest("z".repeat(32)));
  assert.ok(!isDigest(md5("x").slice(0, 31)));
});
