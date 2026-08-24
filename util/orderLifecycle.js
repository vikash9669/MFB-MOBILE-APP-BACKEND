// Accept / decline / expire, and the refund that has to follow a cancellation.
//
// Every transition out of "Received" is a race between four callers: the vendor
// clicking Accept, the vendor clicking Decline, an admin moving the order by
// hand, and the sweeper timing it out at 10 minutes. Two of those give money
// back. So no transition here is a read-then-write — each one is a single
// conditional UPDATE whose WHERE clause carries the expected current state, and
// the row count decides whether this caller won. A loser does nothing and says
// so; it never issues a second refund or overwrites a vendor's accept.
//
// The refund is idempotent on merchantRefundId, which is derived from the
// payment intent's primary key rather than generated randomly. A retry after a
// network timeout therefore reuses the same id, and PhonePe treats it as the
// same refund instead of a second one. That id is claimed with a conditional
// UPDATE against a UNIQUE index before the API call, so two processes cannot
// both decide they are the one refunding.
const sequelize = require("./database");
const { QueryTypes } = require("sequelize");
const { PaymentIntent } = require("../models");
const gateway = require("./gateway");
const { ordersReady, refundsReady } = require("./lifecycleColumns");
const { notifyUser } = require("./customerNotify");
const { notifyPartner } = require("./deliveryNotify");

const RECEIVED = 0;
const PROCESSED = 1;
const CANCELLED = 6;

/**
 * One conditional UPDATE against store_orders, with the lifecycle columns
 * included only when the migration has run.
 *
 * Returns the number of rows changed: 1 if this caller made the transition,
 * 0 if somebody else got there first.
 */
async function transition(orderId, { toStatus, fromStatus, extra = {} }) {
  const sets = ["`order_status` = :toStatus"];
  const replacements = { orderId, toStatus, fromStatus };

  if (await ordersReady()) {
    for (const [column, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      // UTC_TIMESTAMP() rather than a JS Date: order_received_time is already
      // written with a manual +5.5h shift elsewhere, and adding a second
      // convention would make these columns as untrustworthy as that one.
      if (value === "__now__") {
        sets.push(`\`${column}\` = UTC_TIMESTAMP()`);
      } else {
        sets.push(`\`${column}\` = :${column}`);
        replacements[column] = value;
      }
    }
  }

  const [, affected] = await sequelize.query(
    `UPDATE \`store_orders\` SET ${sets.join(", ")}
      WHERE \`order_id\` = :orderId AND \`order_status\` = :fromStatus`,
    { replacements, type: QueryTypes.UPDATE }
  );

  return Number(affected ?? 0);
}

/** The order row, including lifecycle columns when they exist. */
async function readOrder(orderId) {
  const extra = (await ordersReady())
    ? ", `order_accepted_time`, `order_prep_minutes`, `order_cancel_reason`, `order_cancelled_by`"
    : "";
  const rows = await sequelize.query(
    `SELECT \`order_id\`, \`customer_id\`, \`vendor_id\`, \`order_status\`,
            \`order_payment_type\`, \`order_payment_status\`, \`order_amount\`,
            \`delivery_charges\`, \`order_discount\`${extra}
       FROM \`store_orders\` WHERE \`order_id\` = :orderId`,
    { replacements: { orderId }, type: QueryTypes.SELECT }
  );
  return rows[0] ?? null;
}

/**
 * Vendor (or admin) accepts. prepMinutes is what the shop promises.
 *
 * Only 0 -> 1 is allowed, which is what makes this safe to call from a button
 * that a vendor may double-click, and from an admin screen at the same time.
 */
async function acceptOrder({ orderId, prepMinutes, actor = "vendor" }) {
  const minutes = Number(prepMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    return { ok: false, reason: "prep_minutes must be a whole number of minutes between 1 and 240" };
  }

  const changed = await transition(orderId, {
    fromStatus: RECEIVED,
    toStatus: PROCESSED,
    extra: {
      order_accepted_time: "__now__",
      order_prep_minutes: minutes,
      order_updated_by: actor,
    },
  });

  if (changed === 0) {
    const current = await readOrder(orderId);
    return {
      ok: false,
      alreadyHandled: true,
      status: current?.order_status ?? null,
      reason:
        current == null
          ? "Order not found"
          : `Order is already at status ${current.order_status}`,
    };
  }

  // The vendor's prep promise is what lets dispatch be timed instead of
  // guessed: the engine works backwards from it so the rider arrives as the
  // food does. Required lazily to avoid a require cycle, and best-effort —
  // dispatch failing must not undo an accept the vendor already saw succeed.
  try {
    const { scheduleForSourceOrder } = require("./deliveryDispatch");
    await scheduleForSourceOrder(orderId, { prepMinutes: minutes, acceptedAt: new Date() });
  } catch (e) {
    console.log("MFB ~ lifecycle ~ dispatch schedule ~", e.message);
  }

  // Best-effort: the customer should know, but a failed push must not undo an
  // accept the vendor has already been told succeeded.
  const order = await readOrder(orderId);
  notifyUser(order?.customer_id, {
    category: "orders",
    icon: "restaurant",
    title: "Order accepted 👨‍🍳",
    body: `Your order #${orderId} is being prepared. Ready in about ${minutes} minutes.`,
    refOrderId: orderId,
  }).catch((e) => console.log("MFB ~ lifecycle ~ accept notify ~", e.message));

  return { ok: true, orderId, prepMinutes: minutes, status: PROCESSED };
}

/**
 * Vendor declines, or the sweeper times the order out.
 *
 * `by` separates the two so the auto-cancel rate is measurable — before this
 * they were indistinguishable in the data.
 */
async function cancelOrder({ orderId, reason, by = "vendor", actorId = null }) {
  const changed = await transition(orderId, {
    fromStatus: RECEIVED,
    toStatus: CANCELLED,
    extra: {
      order_cancel_reason: String(reason || "").slice(0, 255) || null,
      // Who, as a word: 'vendor' | 'admin' | 'system'. varchar(16).
      order_cancelled_by: by,
      // Who, as a user id. This is `int NOT NULL`, and it used to be handed
      // the same string as order_cancelled_by — so MySQL rejected the write and
      // EVERY decline and auto-cancel failed, refunds included. The sweeper has
      // no user to name, hence the 0 sentinel rather than a lie.
      order_updated_by: Number.isInteger(actorId) ? actorId : 0,
    },
  });

  if (changed === 0) {
    const current = await readOrder(orderId);
    return {
      ok: false,
      alreadyHandled: true,
      status: current?.order_status ?? null,
      reason:
        current == null
          ? "Order not found"
          : `Order is already at status ${current.order_status}`,
    };
  }

  const order = await readOrder(orderId);

  // Take the job out of the rider pool before anything else. The refund and the
  // customer push can both take a while, and every second this stays `offered`
  // is a second a rider can claim an order that no longer exists.
  const retraction = await retractDeliveryJob(orderId, reason);

  const refund = await refundOrderPayment(order, reason);

  const paidOnline = String(order?.order_payment_type).toUpperCase() === "PG";
  let refundLine = "";
  if (paidOnline && refund?.accepted) {
    refundLine = " Your payment is being refunded and should reach you in 3–5 working days.";
  } else if (paidOnline) {
    // Covers a rejected refund, a retryable failure and the pre-migration
    // manual path — from the customer's side these are the same situation.
    refundLine = " Our team is processing your refund and will be in touch.";
  }

  notifyUser(order?.customer_id, {
    category: "orders",
    icon: "cancel",
    title: by === "system" ? "Order cancelled — restaurant didn't respond" : "Order cancelled",
    body:
      (by === "system"
        ? `We're sorry — the restaurant didn't accept order #${orderId} in time, so we've cancelled it.`
        : `Order #${orderId} was cancelled by the restaurant.`) + refundLine,
    refOrderId: orderId,
  }).catch((e) => console.log("MFB ~ lifecycle ~ cancel notify ~", e.message));

  return { ok: true, orderId, status: CANCELLED, by, refund, retraction };
}

/**
 * Retracts the delivery job behind a cancelled order.
 *
 * A job is queued the moment an order is placed, so by the time a vendor
 * declines — or the sweeper times the order out — that job is already sitting
 * in the rider pool marked `offered`, and may even have been claimed. Nothing
 * used to take it back: cancelOrder only touched store_orders, and the offer
 * list filters on the JOB's status without ever looking at the order's. A rider
 * could therefore accept an order that no longer existed, ride to the
 * restaurant, and find nothing waiting — while the customer had already been
 * refunded.
 *
 * Only `offered` and `accepted` are retracted. `picked_up` and `delivered` mean
 * food is already in a bag and in motion; cancelling the job then would strand
 * a rider holding an order with no record of why they are holding it. Those
 * states cannot be reached from RECEIVED anyway, which is the only status
 * cancelOrder transitions out of, so the guard is belt and braces.
 *
 * Never throws. A cancellation that could not retract its job must still leave
 * the order cancelled and the customer refunded — the offers query carries a
 * second, independent guard for exactly this case.
 */
async function retractDeliveryJob(orderId, reason) {
  try {
    const jobs = await sequelize.query(
      `SELECT \`do_id\`, \`dp_id\`, \`status\` FROM \`store_delivery_orders\`
        WHERE \`source_order_id\` = :orderId AND \`status\` IN ('offered', 'accepted')`,
      { replacements: { orderId }, type: QueryTypes.SELECT }
    );

    if (jobs.length === 0) return { retracted: 0 };

    const [, affected] = await sequelize.query(
      `UPDATE \`store_delivery_orders\` SET \`status\` = 'cancelled'
        WHERE \`source_order_id\` = :orderId AND \`status\` IN ('offered', 'accepted')`,
      { replacements: { orderId }, type: QueryTypes.UPDATE }
    );

    // A rider who had already claimed it is on their way somewhere pointless.
    // Best-effort: a push that fails must not undo the retraction.
    for (const job of jobs) {
      if (job.dp_id == null) continue;
      notifyPartner(job.dp_id, {
        category: "orders",
        icon: "cancel",
        title: "Order cancelled",
        body:
          `Order #${orderId} was cancelled` +
          `${reason ? ` — ${String(reason).slice(0, 80)}` : ""}. ` +
          "You don't need to collect it.",
        data: { do_id: String(job.do_id), source_order_id: String(orderId) },
      }).catch((e) =>
        console.log("MFB ~ lifecycle ~ retract notify ~", e.message)
      );
    }

    console.log(
      `MFB ~ lifecycle ~ retracted ${affected ?? jobs.length} delivery job(s) for #${orderId}`
    );
    return { retracted: Number(affected ?? jobs.length) };
  } catch (err) {
    console.log("MFB ~ lifecycle ~ retract delivery job ~", err.message);
    return { retracted: 0, error: err.message };
  }
}

/**
 * Gives the money back for a cancelled order, if it was paid online.
 *
 * Returns null for COD (nothing was taken) and for orders with no settled
 * intent. Never throws: a refund that cannot be issued must still leave the
 * order cancelled, because leaving it "Received" would mean the customer is
 * waiting for food nobody is cooking.
 */
async function refundOrderPayment(order, reason) {
  if (order == null) return null;
  if (String(order.order_payment_type).toUpperCase() !== "PG") return null;

  const intent = await PaymentIntent.findOne({
    where: { order_id: order.order_id, status: "PAID" },
  });
  if (intent == null) return null;

  if (!(await refundsReady())) {
    // Deliberately refuse rather than fire blind. Without somewhere to record
    // the refund id there is no idempotency, and the retry path would pay the
    // customer a second time.
    console.log(
      `MFB ~ REFUND REQUIRED MANUALLY ~ order #${order.order_id} ` +
        `txn ${intent.merchant_txn_id} ₹${intent.amount} — refund columns missing, ` +
        "run migrations/2026-08-09-order-lifecycle.sql"
    );
    return { accepted: false, manual: true, reason: "refund columns missing" };
  }

  // Deterministic, so a retry reuses it instead of creating a second refund.
  const merchantRefundId = `RFB${intent.pi_id}`;

  // The refund columns are deliberately NOT on the PaymentIntent model: adding
  // them would make every existing SELECT name them, and on a database where
  // this migration has not run that breaks checkout — the same trap
  // util/addressColumns.js exists to avoid. So the bookkeeping is raw SQL,
  // reached only after refundsReady() has confirmed the columns are there.
  //
  // Claim it. The UNIQUE index plus `IS NULL` means exactly one caller wins,
  // even across processes.
  const [, claimed] = await sequelize.query(
    `UPDATE \`store_payment_intents\`
        SET \`merchant_refund_id\` = :rid,
            \`refund_status\`      = 'PENDING',
            \`refund_amount\`      = :amount,
            \`refund_failure\`     = :reason
      WHERE \`pi_id\` = :pid AND \`merchant_refund_id\` IS NULL`,
    {
      replacements: {
        rid: merchantRefundId,
        amount: intent.amount,
        reason: String(reason || "").slice(0, 255) || null,
        pid: intent.pi_id,
      },
      type: QueryTypes.UPDATE,
    }
  );

  if (Number(claimed ?? 0) === 0) {
    const [fresh] = await sequelize.query(
      "SELECT `refund_status` FROM `store_payment_intents` WHERE `pi_id` = :pid",
      { replacements: { pid: intent.pi_id }, type: QueryTypes.SELECT }
    );
    return {
      accepted: fresh?.refund_status !== "FAILED",
      alreadyRefunding: true,
      state: fresh?.refund_status ?? null,
    };
  }

  try {
    const result = await gateway.refundPayment({
      merchantRefundId,
      originalMerchantOrderId: intent.merchant_txn_id,
      amountInRupees: Number(intent.amount),
    });

    await sequelize.query(
      `UPDATE \`store_payment_intents\`
          SET \`refund_status\`      = :state,
              \`provider_refund_id\` = :refundId,
              \`refunded_at\`        = ${gateway.isRefundSettled(result.state) ? "UTC_TIMESTAMP()" : "NULL"},
              \`refund_failure\`     = :failure
        WHERE \`pi_id\` = :pid`,
      {
        replacements: {
          state: result.accepted ? result.state : "FAILED",
          refundId: result.refundId,
          failure: result.accepted ? null : String(result.message).slice(0, 255),
          pid: intent.pi_id,
        },
        type: QueryTypes.UPDATE,
      }
    );

    if (!result.accepted) {
      console.log(
        `MFB ~ refund REJECTED ~ order #${order.order_id} ${merchantRefundId}: ${result.message}`
      );
    }

    return { accepted: result.accepted, state: result.state, refundId: result.refundId };
  } catch (err) {
    // The claim stays in place on purpose: the id is now reserved, so the
    // retry path reuses it and PhonePe deduplicates. Clearing it would be the
    // bug that pays twice.
    await sequelize
      .query(
        `UPDATE \`store_payment_intents\`
            SET \`refund_status\` = 'PENDING', \`refund_failure\` = :failure
          WHERE \`pi_id\` = :pid`,
        {
          replacements: { failure: String(err.message).slice(0, 255), pid: intent.pi_id },
          type: QueryTypes.UPDATE,
        }
      )
      .catch(() => {});
    console.log(
      `MFB ~ refund call failed (will retry) ~ order #${order.order_id} ${merchantRefundId}: ${err.message}`
    );
    return { accepted: false, retryable: true, reason: err.message };
  }
}

module.exports = {
  retractDeliveryJob,
  acceptOrder,
  cancelOrder,
  refundOrderPayment,
  readOrder,
  RECEIVED,
  PROCESSED,
  CANCELLED,
};
