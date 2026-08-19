// Whether the accept/decline/refund columns actually exist yet.
//
// Same reasoning as util/addressColumns.js: order placement is load-bearing,
// so an optional lifecycle feature must not be able to break it by naming a
// column the database does not have. We ask once and shape every write to what
// is really there.
//
// The degradation is deliberately asymmetric, because the two column sets
// protect different people:
//
//   store_orders columns missing  -> accept/decline still work, we just cannot
//                                    record prep time or who cancelled. The
//                                    order still moves status, which is what
//                                    the customer and vendor actually see.
//
//   refund columns missing        -> refunds are NOT attempted. Issuing money
//                                    back with nowhere to record the refund id
//                                    is how you refund the same payment twice.
//                                    We log loudly and leave it for a human.
const sequelize = require("./database");

const ORDER_TABLE = "store_orders";
const INTENT_TABLE = "store_payment_intents";

const ORDER_COLUMNS = [
  "order_accepted_time",
  "order_prep_minutes",
  "order_cancel_reason",
  "order_cancelled_by",
];

const REFUND_COLUMNS = [
  "merchant_refund_id",
  "provider_refund_id",
  "refund_status",
  "refund_amount",
  "refunded_at",
  "refund_failure",
];

let state = null;
let probe = null;

async function detect() {
  const result = { orders: false, refunds: false };
  try {
    const qi = sequelize.getQueryInterface();
    const [orders, intents] = await Promise.all([
      qi.describeTable(ORDER_TABLE),
      qi.describeTable(INTENT_TABLE).catch(() => ({})),
    ]);

    result.orders = ORDER_COLUMNS.every((c) => orders[c] != null);
    result.refunds = REFUND_COLUMNS.every((c) => intents[c] != null);

    if (!result.orders || !result.refunds) {
      const missing = [
        !result.orders ? "order lifecycle" : null,
        !result.refunds ? "refunds" : null,
      ]
        .filter(Boolean)
        .join(" + ");
      console.log(
        `MFB ~ order lifecycle: ${missing} columns not found. ` +
          "Run migrations/2026-08-09-order-lifecycle.sql to enable them." +
          (result.refunds ? "" : " Auto-cancelled online orders will be flagged for MANUAL refund.")
      );
    }
  } catch (err) {
    console.log(
      "MFB ~ order lifecycle: could not inspect schema (" +
        (err.original?.sqlMessage || err.message) +
        "); assuming pre-migration schema."
    );
  }
  return result;
}

async function load() {
  if (state != null) return state;
  probe ??= detect().then((r) => {
    state = r;
    probe = null;
    return r;
  });
  return probe;
}

/** True once store_orders carries the accept/cancel bookkeeping columns. */
const ordersReady = async () => (await load()).orders;

/** True once refunds can be recorded. Gating money on this is intentional. */
const refundsReady = async () => (await load()).refunds;

/**
 * Drops lifecycle keys from an update when the columns are absent, so the same
 * call site works on both schemas without branching at every use.
 */
async function orderFields(fields) {
  if (await ordersReady()) return fields;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ORDER_COLUMNS.includes(k)) out[k] = v;
  }
  return out;
}

module.exports = {
  ordersReady,
  refundsReady,
  orderFields,
  ORDER_COLUMNS,
  REFUND_COLUMNS,
  // exported for tests
  _reset: () => {
    state = null;
    probe = null;
  },
};
