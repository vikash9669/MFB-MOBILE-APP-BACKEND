// Whether the dispatch engine's schema exists yet.
//
// Same contract as util/addressColumns.js and util/lifecycleColumns.js: the
// engine must not be able to break delivery for a database where the migration
// has not run. Until the columns exist the engine stays dormant and the old
// open-pool behaviour continues, so this code can ship ahead of the ALTER.
const sequelize = require("../database");

const ORDER_COLUMNS = [
  "dispatch_at",
  "dispatch_state",
  "search_radius_km",
  "offer_round",
  "dispatch_note",
  "batch_id",
];
const PARTNER_COLUMNS = ["dp_max_concurrent", "dp_last_offer_at", "dp_location_at"];

let state = null;
let probe = null;

async function detect() {
  const result = { orders: false, partners: false, offers: false, logs: false };
  try {
    const qi = sequelize.getQueryInterface();
    const [orders, partners] = await Promise.all([
      qi.describeTable("store_delivery_orders").catch(() => ({})),
      qi.describeTable("store_delivery_partners").catch(() => ({})),
    ]);
    result.orders = ORDER_COLUMNS.every((c) => orders[c] != null);
    result.partners = PARTNER_COLUMNS.every((c) => partners[c] != null);

    // The two new tables either exist or they do not.
    const tables = await qi.showAllTables().catch(() => []);
    const names = new Set(tables.map((t) => String(t.tableName ?? t).toLowerCase()));
    result.offers = names.has("store_delivery_offers");
    result.logs = names.has("store_dispatch_logs");
  } catch (err) {
    console.log(
      "MFB ~ dispatch: could not inspect schema (" +
        (err.original?.sqlMessage || err.message) +
        "); engine stays off."
    );
  }
  return result;
}

async function load() {
  if (state != null) return state;
  probe ??= detect().then((r) => {
    state = r;
    probe = null;
    if (!(r.orders && r.partners && r.offers)) {
      console.log(
        "MFB ~ dispatch engine OFF: run migrations/2026-08-09-dispatch-engine.sql " +
          "to enable targeted rider assignment. Riders keep using the open pool."
      );
    }
    return r;
  });
  return probe;
}

/** The engine only runs when its whole schema is present. Partial is not safe. */
const dispatchReady = async () => {
  const s = await load();
  return s.orders && s.partners && s.offers;
};

const logsReady = async () => (await load()).logs;

module.exports = {
  dispatchReady,
  logsReady,
  ORDER_COLUMNS,
  PARTNER_COLUMNS,
  _reset: () => {
    state = null;
    probe = null;
  },
};
