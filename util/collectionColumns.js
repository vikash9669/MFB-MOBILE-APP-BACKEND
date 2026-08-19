// Whether doorstep-collection columns exist yet.
//
// Same contract as util/addressColumns.js and util/lifecycleColumns.js: the
// feature must not be able to break payments on a database where the migration
// has not run. Until the columns exist, /collect returns 503 and everything
// else behaves exactly as before.
const sequelize = require("./database");

const TABLE = "store_payment_intents";
const COLUMNS = ["purpose", "do_id", "collected_by_dp_id", "collect_url", "expires_at"];

let ready = null;
let probe = null;

async function detect() {
  try {
    const described = await sequelize.getQueryInterface().describeTable(TABLE);
    const present = COLUMNS.every((c) => described[c] != null);
    if (!present) {
      console.log(
        "MFB ~ doorstep collection OFF: run migrations/2026-08-12-cod-online-collection.sql " +
          "to let riders take UPI/card at the door."
      );
    }
    return present;
  } catch (err) {
    console.log(
      "MFB ~ doorstep collection: could not inspect schema (" +
        (err.original?.sqlMessage || err.message) +
        "); staying off."
    );
    return false;
  }
}

async function collectionReady() {
  if (ready != null) return ready;
  probe ??= detect().then((r) => {
    ready = r;
    probe = null;
    return r;
  });
  return probe;
}

module.exports = {
  collectionReady,
  COLUMNS,
  _reset: () => {
    ready = null;
    probe = null;
  },
};
