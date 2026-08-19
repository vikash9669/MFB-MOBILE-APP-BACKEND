// Whether the map-pin columns on store_users actually exist.
//
// This mirrors util/addressColumns.js, and for a sharper version of the same
// reason. store_users is the login table: every role — customer, vendor, rider,
// admin — is a row in it. Adding user_lat/user_lng to the Sequelize User model
// would put them in every SELECT the model issues, so on a database where
// 2026-08-18-vendor-geo.sql has not run, signing in would fail with
// "Unknown column 'user_lat' in 'field list'". A map pin is not worth the whole
// panel.
//
// So the columns stay off the model, and everything here goes through raw SQL
// shaped to what the database really has. Before the migration the system
// behaves exactly as it did — dispatch geocodes the pickup from address text.
// After it, pins are read and written with no code change.
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");

const TABLE = "store_users";

// Everything 2026-08-18-vendor-geo.sql adds.
const GEO_COLUMNS = ["user_lat", "user_lng", "user_formatted", "user_place_id"];

// null until probed; then true/false. A single in-flight promise is shared so a
// burst of requests at boot causes one DESCRIBE, not twenty.
let ready = null;
let probe = null;

async function detect() {
  try {
    const described = await sequelize.getQueryInterface().describeTable(TABLE);
    const present = GEO_COLUMNS.every((c) => described[c] != null);
    if (!present) {
      console.log(
        "MFB ~ vendors: map pin columns not found; pickup is geocoded from " +
          "address text. Run migrations/2026-08-18-vendor-geo.sql to enable pins."
      );
    }
    return present;
  } catch (err) {
    // A failed describe must not fail a sign-in or a dispatch. Assume the older
    // schema, which is always safe.
    console.log(
      "MFB ~ vendors: could not inspect schema (" +
        (err.original?.sqlMessage || err.message) +
        "); continuing without map pins."
    );
    return false;
  }
}

/** True when the pin columns are available. Probes once, then caches. */
async function vendorGeoReady() {
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

/** Coerces to a finite number in range, or null. Rejects the 0,0 null island. */
const coord = (value, limit) => {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

/**
 * Normalises a pin payload from a request body.
 *
 * Returns null unless BOTH coordinates are usable — a half-pin is worse than
 * none, because dispatch would treat it as authoritative. 0,0 is rejected as a
 * coordinate pair: it is in the Gulf of Guinea, and in practice it means an
 * uninitialised form field rather than a real place.
 */
function parsePin(input) {
  // A default parameter only fires on `undefined`, and this is fed req.body,
  // which is null on a request with no body at all. Normalise both, plus the
  // primitives a malformed client can send in place of an object.
  const body = input != null && typeof input === "object" ? input : {};

  const lat = coord(body.lat ?? body.user_lat, 90);
  const lng = coord(body.lng ?? body.user_lng, 180);
  if (lat == null || lng == null) return null;
  if (lat === 0 && lng === 0) return null;

  const text = (v, max) => {
    const s = v == null ? "" : String(v).trim();
    return s === "" ? null : s.slice(0, max);
  };

  return {
    lat,
    lng,
    formatted: text(body.formatted ?? body.user_formatted, 255),
    place_id: text(body.place_id ?? body.user_place_id, 128),
  };
}

/**
 * The stored pin for a user, or null.
 *
 * Raw SQL naming only the geo columns: the model does not know about them, and
 * asking for them on an unmigrated database is the failure this file exists to
 * prevent — hence the readiness gate first.
 */
async function readPin(userId) {
  if (!(await vendorGeoReady())) return null;
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const rows = await sequelize.query(
    "SELECT `user_lat`, `user_lng`, `user_formatted`, `user_place_id` " +
      "FROM `store_users` WHERE `user_id` = :id LIMIT 1",
    { replacements: { id }, type: QueryTypes.SELECT }
  );

  const row = rows[0];
  if (row?.user_lat == null || row?.user_lng == null) return null;

  return {
    lat: Number(row.user_lat),
    lng: Number(row.user_lng),
    formatted: row.user_formatted ?? null,
    place_id: row.user_place_id ?? null,
  };
}

/**
 * Saves a pin. Returns what happened, so callers can tell an operator whether
 * the pin they dropped was actually kept.
 *
 * A null pin clears the stored one rather than being ignored: an admin who
 * removes a wrong pin must be able to get back to "no pin", which dispatch
 * handles by geocoding as before.
 */
async function writePin(userId, pin) {
  if (!(await vendorGeoReady())) return { saved: false, reason: "not_migrated" };
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return { saved: false, reason: "bad_user" };

  await sequelize.query(
    "UPDATE `store_users` SET `user_lat` = :lat, `user_lng` = :lng, " +
      "`user_formatted` = :formatted, `user_place_id` = :placeId " +
      "WHERE `user_id` = :id",
    {
      replacements: {
        id,
        lat: pin?.lat ?? null,
        lng: pin?.lng ?? null,
        formatted: pin?.formatted ?? null,
        placeId: pin?.place_id ?? null,
      },
      type: QueryTypes.UPDATE,
    }
  );

  return { saved: true, cleared: pin == null };
}

module.exports = {
  vendorGeoReady,
  parsePin,
  readPin,
  writePin,
  GEO_COLUMNS,
};
