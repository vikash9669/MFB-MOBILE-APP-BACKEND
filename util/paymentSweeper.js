// Reconciles payments the app never came back to confirm.
//
// The happy path is: customer pays, the app calls /user/payment/confirm, the
// backend verifies with PhonePe and creates the order. Two things break it, and
// both are ordinary rather than exotic:
//
//   * the app is killed, backgrounded to death, or loses data at the exact
//     moment it returns from the PhonePe screen — so confirm never fires;
//   * the server-to-server webhook can't reach us — which is the *permanent*
//     state in any environment whose callback URL isn't publicly routable.
//
// With both gone, the intent sits PENDING for ever: the customer has been
// charged and no order exists, and nothing in the system is looking. That is
// the worst failure this codebase can produce, and it is silent.
//
// So we ask PhonePe ourselves. PhonePe's status API is the same authority the
// confirm path already trusts, and settlement goes through the same
// settleIntent as everything else, so a sweep that races a late confirm still
// produces exactly one order.
const { Op } = require("sequelize");
const { PaymentIntent } = require("../models");
const gateway = require("./gateway");
const { settleIntent } = require("./paymentSettlement");
const {
  pendingCollections,
  settleCollection,
  loadCollectionIntent,
  statusFor,
} = require("./codCollection");

// Don't race the app's own confirm — it usually lands within seconds. Sweeping
// too eagerly just doubles the calls to PhonePe for no benefit.
const AFTER_MIN = Number(process.env.PAYMENT_RECONCILE_AFTER_MIN || 2);
// Past this we stop polling. PhonePe resolves orders long before a day is out,
// so anything still PENDING here needs a human, not another status call.
const MAX_AGE_HOURS = Number(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || 24);
// Cap the work per tick so a backlog can't turn into a burst of API calls.
const BATCH = Number(process.env.PAYMENT_RECONCILE_BATCH || 20);
const EVERY_MS = 60000;

const minsAgo = (n) => new Date(Date.now() - n * 60000);

/**
 * One reconciliation pass. Returns a summary of what changed.
 *
 * Every intent is handled independently: one that throws must not stop the
 * others, because the whole point is that these are the payments nothing else
 * is watching.
 */
async function sweepOnce() {
  if (!gateway.isConfigured()) {
    return { skipped: "not_configured", settled: [], failed: [], checked: 0 };
  }

  const due = await PaymentIntent.findAll({
    where: {
      status: "PENDING",
      createdAt: {
        [Op.lt]: minsAgo(AFTER_MIN),
        [Op.gt]: minsAgo(MAX_AGE_HOURS * 60),
      },
    },
    order: [["createdAt", "ASC"]],
    limit: BATCH,
  });

  const settled = [];
  const failed = [];

  // Doorstep collections reconcile separately, because they settle an order
  // that already exists rather than creating one. Without this a customer who
  // paid by QR and immediately lost signal leaves the money at PhonePe and the
  // order still marked cash — the rider having already left.
  try {
    const collections = await pendingCollections(BATCH);
    for (const intent of collections) {
      // statusFor, not gateway.fetchStatus: a doorstep QR may have been raised
      // through the offline Dynamic QR product, whose transactions the PG
      // status API cannot see at all.
      const status = await statusFor(intent);
      if (status.success) {
        const result = await settleCollection(intent);
        if (result.ok && !result.alreadySettled) {
          settled.push(`${intent.merchant_txn_id} -> doorstep #${intent.do_id}`);
        }
      }
    }
  } catch (err) {
    console.log("MFB ~ payment sweeper ~ collections ~", err.message);
  }

  for (const intent of due) {
    try {
      // Already handled above, and it must not go down the order-creating path.
      if (await loadCollectionIntent(intent.merchant_txn_id)) {
        continue;
      }
      const status = await gateway.fetchStatus(intent.merchant_txn_id);

      if (status.success) {
        const { order_id, alreadySettled } = await settleIntent(
          intent,
          status.providerTxnId
        );
        if (!alreadySettled) {
          settled.push(`${intent.merchant_txn_id} -> order ${order_id}`);
        }
      } else if (!status.pending) {
        await intent.update({
          status: "FAILED",
          failure_reason: `${status.state}: ${status.message || "reconciled"}`.slice(0, 255),
        });
        failed.push(`${intent.merchant_txn_id} (${status.state})`);
      }
      // Still pending at PhonePe's end — leave it and look again next tick.
    } catch (err) {
      // A single bad intent must not abort the pass.
      console.log(
        "MFB-error-logs ~ payment sweeper ~",
        intent.merchant_txn_id,
        "~",
        err.response?.status || "",
        err.message
      );
    }
  }

  if (settled.length) {
    console.log(
      "MFB ~ payment sweeper ~ recovered paid-but-unconfirmed:",
      settled.join(", ")
    );
  }
  if (failed.length) {
    console.log("MFB ~ payment sweeper ~ marked failed:", failed.join(", "));
  }

  return { settled, failed, checked: due.length };
}

/** Payments stuck past MAX_AGE_HOURS. Money may have moved; a human must look. */
async function abandonedCount() {
  return PaymentIntent.count({
    where: {
      status: "PENDING",
      createdAt: { [Op.lt]: minsAgo(MAX_AGE_HOURS * 60) },
    },
  });
}

/** Runs the sweep on a timer. Never throws — this must not take the server down. */
function startPaymentSweeper() {
  let warned = false;
  let reportedAbandoned = -1;

  const tick = async () => {
    try {
      await sweepOnce();

      // Report the stuck pile only when it changes, so it stays visible without
      // becoming a log every minute that everyone learns to ignore.
      const stuck = await abandonedCount();
      if (stuck > 0 && stuck !== reportedAbandoned) {
        reportedAbandoned = stuck;
        console.log(
          `MFB ~ payment sweeper ~ ${stuck} payment(s) stuck PENDING for over ` +
            `${MAX_AGE_HOURS}h and no longer polled. These may be charged with no ` +
            "order — review store_payment_intents manually."
        );
      }
    } catch (err) {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ payment sweeper idle: " +
          (err.original?.sqlMessage || err.message) +
          ". Online payment reconciliation is not running."
      );
    }
  };

  tick();
  const timer = setInterval(tick, EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  sweepOnce,
  abandonedCount,
  startPaymentSweeper,
  AFTER_MIN,
  MAX_AGE_HOURS,
};
