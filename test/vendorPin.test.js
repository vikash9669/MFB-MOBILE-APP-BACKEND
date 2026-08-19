const test = require("node:test");
const assert = require("node:assert");

const { parsePin } = require("../util/vendorColumns");

// Vendor kitchen map pins.
//
// The pin decides where dispatch thinks a restaurant is, and dispatch scores
// riders by distance to that point. A bad pin is worse than no pin: with no pin
// the address is geocoded and lands roughly right, whereas a wrong pin is
// believed absolutely. So parsePin is deliberately strict, and these tests pin
// down what it refuses.

test("a well-formed pin is accepted and normalised to numbers", () => {
  const pin = parsePin({ lat: "23.2599", lng: "77.4126" });
  assert.deepEqual(pin, { lat: 23.2599, lng: 77.4126, formatted: null, place_id: null });
});

test("both coordinates are required — half a pin is not a pin", () => {
  // A form that lost one field would otherwise store a coordinate paired with
  // NULL, which readPin reports as "no pin" anyway. Rejecting here keeps the
  // two ends agreeing.
  assert.equal(parsePin({ lat: 23.2599 }), null);
  assert.equal(parsePin({ lng: 77.4126 }), null);
  assert.equal(parsePin({}), null);
});

test("0,0 is rejected — it means an empty form, not the Gulf of Guinea", () => {
  assert.equal(parsePin({ lat: 0, lng: 0 }), null);
});

test("a real coordinate on one axis and zero on the other is still valid", () => {
  // Only the pair is meaningless. The equator and the prime meridian are real
  // places, and refusing them would be superstition rather than validation.
  assert.deepEqual(parsePin({ lat: 0, lng: 77.4126 }).lng, 77.4126);
  assert.deepEqual(parsePin({ lat: 23.2599, lng: 0 }).lat, 23.2599);
});

test("out-of-range coordinates are refused", () => {
  assert.equal(parsePin({ lat: 91, lng: 77 }), null);
  assert.equal(parsePin({ lat: 23, lng: 181 }), null);
  assert.equal(parsePin({ lat: -90.1, lng: 0 }), null);
});

test("junk that Number() would turn into NaN is refused", () => {
  assert.equal(parsePin({ lat: "here", lng: "there" }), null);
  assert.equal(parsePin({ lat: null, lng: null }), null);
  assert.equal(parsePin({ lat: undefined, lng: undefined }), null);
  // Infinity survives Number() but is not a place.
  assert.equal(parsePin({ lat: Infinity, lng: 77 }), null);
});

test("both the wire spelling and the column spelling are accepted", () => {
  // The panel sends lat/lng; anything replaying a database row sends the
  // column names. Both reach this function.
  const wire = parsePin({ lat: 23.1, lng: 77.1 });
  const columns = parsePin({ user_lat: 23.1, user_lng: 77.1 });
  assert.deepEqual(wire, columns);
});

test("the label and place id are trimmed, capped and nulled when blank", () => {
  const pin = parsePin({
    lat: 23.2599,
    lng: 77.4126,
    formatted: "  MP Nagar, Bhopal  ",
    place_id: "   ",
  });
  assert.equal(pin.formatted, "MP Nagar, Bhopal");
  // An empty string would be stored as an empty label and rendered as one.
  assert.equal(pin.place_id, null);

  const long = parsePin({ lat: 1, lng: 1, formatted: "x".repeat(400) });
  // The column is varchar(255); truncating here beats a MySQL error on save.
  assert.equal(long.formatted.length, 255);
});

test("parsePin never throws on a hostile body", () => {
  // It is fed req.body directly, so it must survive anything.
  for (const body of [null, undefined, [], "string", 42, { lat: {}, lng: [] }]) {
    assert.doesNotThrow(() => parsePin(body));
  }
});
