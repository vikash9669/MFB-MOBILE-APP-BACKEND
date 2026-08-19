const test = require("node:test");
const assert = require("node:assert");

const { parseStars, parseTags, parseComment } = require("../util/ratings");

// Rider ratings.
//
// These are not cosmetic stars. dp_rating feeds the `rating` term in dispatch
// scoring (util/dispatch/scoring.js), so a value that gets in here changes
// which rider is offered work and therefore what somebody earns. That is the
// reason the parsers are strict rather than forgiving, and it is what these
// tests hold in place.

test("stars accept the whole numbers 1 to 5 and nothing else", () => {
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(parseStars(n), n);
  }
  assert.equal(parseStars("4"), 4, "a numeric string from a form body is fine");
});

test("stars refuse values that would skew an average", () => {
  // 0 and 6 are the off-by-one a slider or a loop index produces; 4.5 is a
  // half-star UI sending what it renders. All three would quietly move a
  // rider's score somewhere no customer chose.
  assert.equal(parseStars(0), null);
  assert.equal(parseStars(6), null);
  assert.equal(parseStars(4.5), null);
  assert.equal(parseStars(-3), null);
});

test("stars refuse junk rather than coercing it", () => {
  // Number("") is 0 and Number(null) is 0 — both would sail through a naive
  // `Number(x) >= 0` check and record a rating nobody gave.
  assert.equal(parseStars(""), null);
  assert.equal(parseStars(null), null);
  assert.equal(parseStars(undefined), null);
  assert.equal(parseStars("five"), null);
  assert.equal(parseStars({}), null);
  assert.equal(parseStars([]), null);
});

test("tags accept both shapes the two apps send", () => {
  assert.equal(parseTags(["polite", "on_time"]), "polite,on_time");
  assert.equal(parseTags("polite, on_time"), "polite,on_time");
});

test("tags are lowercased, de-duplicated and capped at six", () => {
  assert.equal(parseTags(["Polite", "polite", "POLITE"]), "polite");
  const many = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assert.equal(parseTags(many).split(",").length, 6);
});

test("tags drop anything that is not a plain slug", () => {
  // The column is free text, so a tag is the one field a client could use to
  // smuggle punctuation or markup into an admin screen. Only slugs survive.
  assert.equal(parseTags(["<script>", "ok_tag", "  ", "hé"]), "ok_tag");
  assert.equal(parseTags([]), null);
  assert.equal(parseTags(""), null);
  assert.equal(parseTags(null), null);
});

test("an over-long tag is dropped, not truncated", () => {
  // 24 characters is the limit in the slug pattern. Truncating instead would
  // silently turn one tag into a different, shorter tag.
  assert.equal(parseTags(["x".repeat(25)]), null);
  assert.equal(parseTags(["x".repeat(24)]), "x".repeat(24));
});

test("the worst legal tag set still fits the column", () => {
  // Six tags of 24 characters plus five commas is 149 — comfortably inside
  // VARCHAR(255). Worth pinning down: it means the per-tag and count limits
  // are what protect the column, and the slice() in parseTags is belt-and-
  // braces rather than the thing doing the work. If either limit is ever
  // raised, this is the test that should fail first.
  const worst = Array.from({ length: 6 }, (_, i) => "x".repeat(23) + i);
  const out = parseTags(worst);
  assert.equal(out.split(",").length, 6);
  assert.ok(out.length <= 255, `expected <= 255, got ${out.length}`);
});

test("comments are trimmed, collapsed and capped", () => {
  assert.equal(parseComment("  great   rider \n thanks "), "great rider thanks");
  assert.equal(parseComment("x".repeat(900)).length, 500);
});

test("an empty comment is null, not an empty string", () => {
  // So "did they leave a comment?" is a null check everywhere rather than
  // sometimes a null check and sometimes a length check.
  assert.equal(parseComment("   "), null);
  assert.equal(parseComment(""), null);
  assert.equal(parseComment(null), null);
  assert.equal(parseComment(undefined), null);
});
