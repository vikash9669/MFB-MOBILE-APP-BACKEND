// Whether the rider-ratings table exists yet.
//
// Same contract as util/collectionColumns.js and util/vendorColumns.js: a
// feature must not be able to break the app on a database where its migration
// has not run. Until store_delivery_ratings exists, the customer app is told
// there is nothing to rate, the rider's performance screen falls back to the
// behaviour it had before, and no endpoint 500s.
const sequelize = require("./database");

const TABLE = "store_delivery_ratings";

let ready = null;
let probe = null;

async function detect() {
  try {
    await sequelize.getQueryInterface().describeTable(TABLE);
    return true;
  } catch {
    // describeTable throws for a missing table, which is the expected state
    // before the migration — say so once, quietly, rather than as an error.
    console.log(
      "MFB ~ rider ratings OFF: run migrations/2026-08-19-pending-combined.md " +
        "to let customers rate their delivery partner."
    );
    return false;
  }
}

async function ratingsReady() {
  if (ready != null) return ready;
  probe ??= detect().then((r) => {
    ready = r;
    probe = null;
    return r;
  });
  return probe;
}

module.exports = {
  ratingsReady,
  TABLE,
  _reset: () => {
    ready = null;
    probe = null;
  },
};
