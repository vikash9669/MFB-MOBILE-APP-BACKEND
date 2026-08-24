const test = require("node:test");
const assert = require("node:assert");

const { ensureAddressPin, hasPin } = require("../util/addressGeo");

// Filling in coordinates for an address that has none.
//
// The expensive path (an actual Google lookup) is not exercised here — what
// matters is that it is NOT taken for the addresses that already have a pin,
// which is every address created through the app and will be the overwhelming
// majority of orders. A regression there would mean paying for a geocode on
// every single order.

const withPin = { delivery_id: 1, delivery_lat: 23.2599, delivery_lng: 77.4126 };

test("an address that already has coordinates is recognised", () => {
  assert.strictEqual(hasPin(withPin), true);
});

test("0,0 is treated as missing, not as a location", () => {
  // The Gulf of Guinea. In this data it means "column defaulted, never set",
  // and taking it literally puts the customer's house in the Atlantic.
  assert.strictEqual(hasPin({ delivery_lat: 0, delivery_lng: 0 }), false);
  assert.strictEqual(hasPin({ delivery_lat: "0", delivery_lng: "0" }), false);
});

test("a real coordinate on one axis and zero on the other is still a location", () => {
  // 0 longitude is the prime meridian — a real place. Only BOTH being zero is
  // the sentinel.
  assert.strictEqual(hasPin({ delivery_lat: 51.4779, delivery_lng: 0 }), true);
});

test("missing, blank and non-numeric coordinates are all 'no pin'", () => {
  for (const a of [
    null,
    undefined,
    {},
    { delivery_lat: null, delivery_lng: null },
    { delivery_lat: "", delivery_lng: "" },
    { delivery_lat: "abc", delivery_lng: "def" },
    { delivery_lat: 23.2599 }, // half a pin is not a pin
  ]) {
    assert.strictEqual(hasPin(a), false, `treated ${JSON.stringify(a)} as a pin`);
  }
});

test("an address with a pin is returned as-is, without geocoding or writing", async () => {
  // The guard that stops every order paying for a lookup. If this ever calls
  // update(), the test fails rather than the bill rising quietly.
  let updated = false;
  const address = {
    ...withPin,
    update: async () => {
      updated = true;
    },
  };
  const point = await ensureAddressPin(address);
  assert.deepStrictEqual(point, { lat: 23.2599, lng: 77.4126 });
  assert.strictEqual(updated, false, "wrote to an address that already had a pin");
});

test("a null address is handled rather than thrown on", async () => {
  assert.strictEqual(await ensureAddressPin(null), null);
  assert.strictEqual(await ensureAddressPin(undefined), null);
});

test("coordinates stored as strings still count", async () => {
  // DECIMAL columns come back from mysql2 as strings.
  const point = await ensureAddressPin({
    delivery_id: 2,
    delivery_lat: "23.2599000",
    delivery_lng: "77.4126000",
  });
  assert.deepStrictEqual(point, { lat: 23.2599, lng: 77.4126 });
});
