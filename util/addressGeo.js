// Filling in a delivery address's coordinates when it has none.
//
// WHY THIS IS NEEDED
// The customer app's map picker saves a pin with every address it creates, so
// anything added through the app already has coordinates. The database also
// holds tens of thousands of addresses from the PHP era, which have none — and
// an order placed against one of those has no destination to draw on a map.
//
// Rather than geocode the whole backlog (most of which will never be used
// again), an address is looked up the first time an order is actually placed
// against it, and the answer is written back. Each address therefore costs one
// lookup, ever, and only if somebody orders to it.
//
// NEVER THROWS, and never blocks an order. A missing pin costs a map; a
// geocoder that fails must not cost the order itself.
const { geocode } = require("./geo");
const { geoReady } = require("./addressColumns");

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const hasPin = (address) =>
  num(address?.delivery_lat) != null &&
  num(address?.delivery_lng) != null &&
  // 0,0 is the Gulf of Guinea, and in this data it means "never set".
  !(Number(address.delivery_lat) === 0 && Number(address.delivery_lng) === 0);

/**
 * Ensures the address row has coordinates, geocoding it once if not.
 *
 * Returns { lat, lng } when the address has (or now has) a pin, otherwise null.
 * Safe to call on every order — it is a no-op for an address that already has
 * one, which is every address created through the app.
 */
async function ensureAddressPin(address) {
  try {
    if (address == null) return null;
    if (hasPin(address)) {
      return { lat: Number(address.delivery_lat), lng: Number(address.delivery_lng) };
    }
    // The columns may not exist on an older restore. Nothing to write to.
    if (!(await geoReady())) return null;

    const point = await geocode(
      [
        address.delivery_house,
        address.delivery_address,
        address.delivery_landmark,
        address.delivery_pin,
      ],
      { pincode: address.delivery_pin }
    );
    if (point == null || num(point.lat) == null || num(point.lng) == null) {
      return null;
    }

    // Only the two coordinate columns. geocode() returns nothing else — no
    // formatted address, no place id — and an address row carries the
    // customer's own text, which a background job has no business rewriting.
    // The explicit `fields` list is what guarantees that.
    await address.update(
      { delivery_lat: point.lat, delivery_lng: point.lng },
      { fields: ["delivery_lat", "delivery_lng"] }
    );

    console.log(
      `MFB ~ address ${address.delivery_id}: geocoded and cached (had no coordinates)`
    );
    return { lat: Number(point.lat), lng: Number(point.lng) };
  } catch (err) {
    console.log("MFB-error-logs ~ ensureAddressPin ~", err.message);
    return null;
  }
}

module.exports = { ensureAddressPin, hasPin };
