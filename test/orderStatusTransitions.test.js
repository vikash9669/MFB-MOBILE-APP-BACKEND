// The admin panel's status rule: one step at a time, forwards only, with
// Cancelled as the deliberate way out.
//
// Worth its own test because the screen it backs is a row of seven buttons, and
// the interesting cases are the ones a button press can no longer produce —
// Received straight to Delivered, or a delivered order rewound to Received.
// Those reached the database before this rule existed.
const test = require("node:test");
const assert = require("node:assert");

const { _statusTransitionRefusal: refusal } = require("../controllers/admin/orders");

const RECEIVED = 0;
const PROCESSED = 1;
const VENDOR = 2;
const READY = 3;
const ON_THE_WAY = 4;
const DELIVERED = 5;
const CANCELLED = 6;

test("one step forward is allowed, at every step", () => {
  for (const [from, to] of [
    [RECEIVED, PROCESSED],
    [PROCESSED, VENDOR],
    [VENDOR, READY],
    [READY, ON_THE_WAY],
    [ON_THE_WAY, DELIVERED],
  ]) {
    assert.strictEqual(refusal(from, to), null, `${from} -> ${to} should be allowed`);
  }
});

test("skipping ahead is refused, and says which step comes next", () => {
  const why = refusal(RECEIVED, DELIVERED);
  assert.match(why, /Processed comes next/);
  assert.match(why, /one at a time/);
  assert.notStrictEqual(refusal(PROCESSED, ON_THE_WAY), null);
});

test("going backwards is refused", () => {
  assert.match(refusal(ON_THE_WAY, RECEIVED), /cannot go back to Received/);
  assert.notStrictEqual(refusal(DELIVERED, READY), null);
});

test("the status it is already on is refused rather than logged again", () => {
  assert.match(refusal(VENDOR, VENDOR), /already at this status/);
});

test("cancelling is allowed from anywhere, including mid-delivery", () => {
  for (const from of [RECEIVED, PROCESSED, VENDOR, READY, ON_THE_WAY, DELIVERED]) {
    assert.strictEqual(refusal(from, CANCELLED), null, `cancel from ${from} should be allowed`);
  }
});

test("a cancelled order is frozen — nothing moves it, not even cancelling again", () => {
  for (const to of [RECEIVED, PROCESSED, READY, DELIVERED, CANCELLED]) {
    assert.match(refusal(CANCELLED, to), /was cancelled/);
  }
});
