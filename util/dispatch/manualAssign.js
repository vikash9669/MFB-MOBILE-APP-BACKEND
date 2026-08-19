// Hand a delivery job to a specific rider, because an operator said so.
//
// The panel's Orders screen has always had a rider dropdown. It wrote
// store_orders.rider_id and emailed the rider — which was the whole mechanism
// before the delivery app existed. It still is: nothing here replaces the
// automatic engine, it gives the manual path the same reach the engine has.
//
// Without this the two systems agree on nothing. The panel says "assigned",
// store_orders.rider_id holds a store_users id, and the app — which reads
// store_delivery_orders by dp_id — shows "No orders right now". An operator
// reassigning a stuck order is doing it precisely because something has gone
// wrong, so that is the worst possible moment for the assignment to be a no-op.
//
// This is deliberately an OVERRIDE and skips the offer ladder: no offer, no
// 3-minute window, no scoring, no chance to decline. A human with the whole
// board in front of them has already made the decision the engine would be
// guessing at. It is recorded as `manual_assign` in store_dispatch_logs so the
// dispatch timeline shows who really made the call.
const { QueryTypes } = require("sequelize");
const sequelize = require("../database");
const { DeliveryOrder } = require("../../models");
const { logDispatch } = require("./offers");
const { dispatchReady } = require("./columns");

/** Statuses a job can still be reassigned from. */
const REASSIGNABLE = new Set(["offered", "accepted"]);

/**
 * Assigns the delivery job for `sourceOrderId` to `dpId`.
 *
 * Never throws: an assignment must not fail the panel's status update, which
 * has already been committed by the time this runs.
 *
 * Returns { assigned, do_id, reason } — `reason` explains every refusal so the
 * panel can say something truer than "Notifications sent".
 */
async function assignJobToPartner(sourceOrderId, dpId, { previousDpId } = {}) {
  try {
    const job = await DeliveryOrder.findOne({
      where: { source_order_id: sourceOrderId },
    });

    // No job yet — the vendor has not accepted, so there is nothing to steer.
    // Deliberately NOT created here: the job carries the vendor's prep promise,
    // and inventing one early would dispatch a rider to a kitchen that has not
    // agreed to cook yet.
    if (job == null) {
      return {
        assigned: false,
        reason:
          "no delivery job yet — the vendor has not accepted this order, so the rider app has nothing to show",
      };
    }

    if (!REASSIGNABLE.has(job.status)) {
      return {
        assigned: false,
        do_id: job.do_id,
        reason: `delivery job is already ${job.status}`,
      };
    }

    if (Number(job.dp_id) === Number(dpId)) {
      return { assigned: true, do_id: job.do_id, reason: "already assigned to this rider" };
    }

    // Claim conditionally on the status we just read, so a rider accepting an
    // engine offer in the same moment cannot be silently overwritten mid-flight
    // — one of the two writes loses, and it is visible which.
    const [, claimed] = await sequelize.query(
      `UPDATE \`store_delivery_orders\`
          SET \`dp_id\` = :dpId,
              \`status\` = 'accepted',
              \`accepted_at\` = COALESCE(\`accepted_at\`, UTC_TIMESTAMP())
              ${(await dispatchReady()) ? ", `dispatch_state` = 'assigned'" : ""}
        WHERE \`do_id\` = :doId AND \`status\` = :expected`,
      {
        replacements: { doId: job.do_id, dpId, expected: job.status },
        type: QueryTypes.UPDATE,
      }
    );

    if (Number(claimed ?? 0) === 0) {
      return {
        assigned: false,
        do_id: job.do_id,
        reason: "the job changed hands while assigning — reload and try again",
      };
    }

    // Any offer still in flight is moot now, including one this rider was
    // already holding. Left pending, the engine's expiry sweep would later log
    // an expire against a job somebody is actively delivering.
    if (await dispatchReady()) {
      await sequelize.query(
        `UPDATE \`store_delivery_offers\` SET \`state\` = 'withdrawn'
          WHERE \`do_id\` = :doId AND \`state\` = 'pending'`,
        { replacements: { doId: job.do_id }, type: QueryTypes.UPDATE }
      );
      await logDispatch(job.do_id, "manual_assign", {
        dpId,
        detail: previousDpId ? `reassigned from dp ${previousDpId}` : "assigned from the panel",
      });
    }

    return { assigned: true, do_id: job.do_id, reason: "assigned" };
  } catch (err) {
    console.log("MFB-error-logs ~ dispatch ~ manual assign ~ err:", err.message);
    return { assigned: false, reason: `assignment failed: ${err.message}` };
  }
}

module.exports = { assignJobToPartner };
