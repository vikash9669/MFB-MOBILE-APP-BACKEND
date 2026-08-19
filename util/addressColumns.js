// Whether the map columns on store_users_shipping_address actually exist.
//
// Addresses are load-bearing: without them there is no checkout. So the map
// feature is not allowed to assume its own schema. Adding the columns to the
// Sequelize model is enough to make every SELECT name them, and on a database
// where the ALTER has not run that turns "list my addresses" into
// "Unknown column 'delivery_lat' in 'field list'" — the whole cart, broken by
// an optional feature.
//
// So we ask the database once, at first use, and shape every query to what is
// really there. Before the migration the app behaves exactly as it did; after
// it, the map fields light up with no restart needed beyond the usual one.
const sequelize = require("./database");

const TABLE = "store_users_shipping_address";

// Everything 2026-08-08-address-geo.sql adds. Order matters only for reading.
const GEO_COLUMNS = [
  "delivery_lat",
  "delivery_lng",
  "delivery_house",
  "delivery_label",
  "delivery_formatted",
  "delivery_place_id",
];

// The columns that predate the migration, and so are always safe to touch.
const BASE_COLUMNS = [
  "delivery_id",
  "customer_id",
  "delivery_address",
  "delivery_landmark",
  "delivery_phone",
  "delivery_pin",
  "delivery_city",
  "delivery_state",
  "delivery_status",
];

// null until probed; then true/false. A single in-flight promise is shared so
// a burst of concurrent requests at boot causes one DESCRIBE, not twenty.
let ready = null;
let probe = null;

async function detect() {
  try {
    const described = await sequelize.getQueryInterface().describeTable(TABLE);
    const present = GEO_COLUMNS.every((c) => described[c] != null);
    if (!present) {
      console.log(
        "MFB ~ addresses: map columns not found; saving pins is disabled. " +
          "Run migrations/2026-08-08-address-geo.sql to enable it."
      );
    }
    return present;
  } catch (err) {
    // A describe that fails is not a reason to fail a checkout. Assume the
    // older schema, which is always safe to query.
    console.log(
      "MFB ~ addresses: could not inspect schema (" +
        (err.original?.sqlMessage || err.message) +
        "); continuing without map columns."
    );
    return false;
  }
}

/** True when the pin columns are available. Probes once, then caches. */
async function geoReady() {
  if (ready !== null) return ready;
  if (probe === null) {
    probe = detect().then((result) => {
      ready = result;
      probe = null;
      return result;
    });
  }
  return probe;
}

/** The attribute list to SELECT — base columns, plus geo when it exists. */
async function addressAttributes() {
  return (await geoReady()) ? [...BASE_COLUMNS, ...GEO_COLUMNS] : [...BASE_COLUMNS];
}

/**
 * Narrows a payload to columns that exist, so INSERT and UPDATE never name a
 * missing one. Returns the field list Sequelize should write, which is the
 * only reliable way to stop it inferring one from the model.
 */
async function writableFields(payload) {
  const allowed = new Set(await addressAttributes());
  return Object.keys(payload).filter(
    (k) => allowed.has(k) && k !== "delivery_id" && payload[k] !== undefined
  );
}

/** Drops geo keys from a payload when the columns aren't there. */
async function stripGeo(payload) {
  if (await geoReady()) return payload;
  const out = { ...payload };
  GEO_COLUMNS.forEach((c) => delete out[c]);
  return out;
}

module.exports = {
  geoReady,
  addressAttributes,
  writableFields,
  stripGeo,
  GEO_COLUMNS,
  BASE_COLUMNS,
};
