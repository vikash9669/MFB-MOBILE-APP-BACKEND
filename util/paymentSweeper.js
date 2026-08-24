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
const { Op, QueryTypes } = require("sequelize");
const sequelize = require("./database");
const { refundsReady } = require("./lifecycleColumns");
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
          status.providerTxnId,
          status.amountInRupees
        );
        if (!alreadySettled && order_id != null) {
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

/**
 * Chases refunds we started and never heard back about.
 *
 * refundPayment records PENDING and returns — every gateway settles refunds
 * asynchronously, over days for cards. Nothing polled after that, so the column
 * stayed PENDING for ever: a refund the gateway later REJECTED looked identical
 * to one still in flight, and the customer simply never got their money while
 * the row said everything was fine.
 *
 * Read and written with raw SQL because the refund columns are deliberately not
 * on the PaymentIntent model — see util/orderLifecycle.js — and are only
 * present once the migration has run.
 */
async function reconcileRefunds() {
  if (!(await refundsReady())) return { checked: 0, settled: 0, failed: 0 };

  const rows = await sequelize.query(
    `SELECT \`pi_id\`, \`merchant_txn_id\`, \`merchant_refund_id\`, \`order_id\`,
            \`refund_amount\`
       FROM \`store_payment_intents\`
      WHERE \`merchant_refund_id\` IS NOT NULL
        AND \`refund_status\` = 'PENDING'
      ORDER BY \`pi_id\` ASC
      LIMIT :batch`,
    { replacements: { batch: BATCH }, type: QueryTypes.SELECT }
  );

  let settled = 0;
  let failed = 0;

  for (const row of rows) {
    let status;
    try {
      status = await gateway.fetchRefundStatus({
        merchantRefundId: row.merchant_refund_id,
        originalMerchantOrderId: row.merchant_txn_id,
      });
    } catch (err) {
      // Transient. Leave it PENDING and try again next tick.
      console.log(`MFB ~ refund sweep ~ ${row.merchant_refund_id} ~ ${err.message}`);
      continue;
    }

    if (status.completed) {
      await sequelize.query(
        `UPDATE \`store_payment_intents\`
            SET \`refund_status\` = 'COMPLETED', \`refunded_at\` = UTC_TIMESTAMP()
          WHERE \`pi_id\` = :pid AND \`refund_status\` = 'PENDING'`,
        { replacements: { pid: row.pi_id }, type: QueryTypes.UPDATE }
      );
      settled += 1;
      console.log(
        `MFB ~ refund sweep ~ ${row.merchant_refund_id} completed (order #${row.order_id})`
      );
    } else if (status.failed) {
      await sequelize.query(
        `UPDATE \`store_payment_intents\`
            SET \`refund_status\` = 'FAILED', \`refund_failure\` = :reason
          WHERE \`pi_id\` = :pid AND \`refund_status\` = 'PENDING'`,
        {
          replacements: { pid: row.pi_id, reason: String(status.message).slice(0, 255) },
          type: QueryTypes.UPDATE,
        }
      );
      failed += 1;
      // A rejected refund means the customer is still out of pocket and nothing
      // else in the system will notice. This is the one that has to reach a human.
      const { notifyAdminsRefundFailed } = require("./adminNotify");
      notifyAdminsRefundFailed({
        merchantRefundId: row.merchant_refund_id,
        orderId: row.order_id,
        amount: row.refund_amount,
        reason: status.message,
      }).catch((e) => console.log("MFB ~ refund sweep ~ alert ~", e.message));
    }
    // Anything else (PENDING, ONHOLD) is still in flight: leave it alone.
  }

  return { checked: rows.length, settled, failed };
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
      await reconcileRefunds();

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
        // A log line on a hosted box is not a signal anyone receives. This is
        // the worst state the system can produce, so it goes to the people who
        // can do something about it.
        const { notifyAdminsPaymentsStuck } = require("./adminNotify");
        notifyAdminsPaymentsStuck({ count: stuck, hours: MAX_AGE_HOURS }).catch((e) =>
          console.log("MFB ~ payment sweeper ~ stuck alert ~", e.message)
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
  reconcileRefunds,
  sweepOnce,
  abandonedCount,
  startPaymentSweeper,
  AFTER_MIN,
  MAX_AGE_HOURS,
};
