// The panel assigning an order to a rider, end to end.
//
// One place, because two panel actions need identical behaviour — assigning a
// rider on the Orders screen, and "Resend notification" on the same screen —
// and they previously only agreed on sending an email. If they drift, an
// operator gets a different outcome depending on which button they pressed,
// which is worse than either behaviour on its own.
//
// The chain is: panel rider (store_users) → delivery partner (dp_id) →
// delivery job (store_delivery_orders) → push to the partner's devices. Every
// link can legitimately be missing, and each one reports why rather than
// failing silently — "Notifications sent." on a screen where nothing was sent
// is how this went unnoticed in the first place.
const { findPartnerForPanelRider } = require("./riderLink");
const { assignJobToPartner } = require("./dispatch/manualAssign");
const { notifyPartner } = require("./deliveryNotify");

/**
 * Puts order `orderId` in front of panel rider `riderId` on their phone.
 *
 * Never throws. Returns a plain result the panel can render:
 *   { ok, dp_id, do_id, assigned, pushed, reason }
 */
async function assignToPanelRider(orderId, riderId, { previousRiderId } = {}) {
  try {
    const partner = await findPartnerForPanelRider(riderId);
    if (partner == null) {
      // A rider who exists on the panel but has never onboarded in the app.
      // Expected and not an error: the panel's rider list predates the app.
      return {
        ok: false,
        reason:
          "this rider has no delivery-app account (matched by phone), so only the email applies",
      };
    }

    if (partner.dp_verification_status !== "approved") {
      return {
        ok: false,
        dp_id: partner.dp_id,
        reason: `rider's app account is ${partner.dp_verification_status}, not approved — they cannot accept work yet`,
      };
    }

    let previousDpId = null;
    if (previousRiderId && Number(previousRiderId) !== Number(riderId)) {
      const prev = await findPartnerForPanelRider(previousRiderId);
      previousDpId = prev?.dp_id ?? null;
    }

    const result = await assignJobToPartner(orderId, partner.dp_id, { previousDpId });

    if (!result.assigned) {
      return { ok: false, dp_id: partner.dp_id, do_id: result.do_id, reason: result.reason };
    }

    // The push is what actually makes the phone light up. Awaited so the panel
    // can report whether it went out, but never allowed to fail the assignment
    // that is already written.
    let pushed = false;
    let pushReason = null;
    try {
      await notifyPartner(partner.dp_id, {
        category: "orders",
        icon: "assignment",
        title: "New delivery assigned",
        body: `Order #${orderId} has been assigned to you. Open the app to start.`,
        // Call-style, like an engine offer: a manual assignment is usually the
        // rescue of a job nobody picked up, so it is the last thing that should
        // arrive as a silent tray notification.
        call: true,
        data: { do_id: String(result.do_id), order_id: String(orderId) },
      });
      pushed = true;
    } catch (err) {
      pushReason = err.message;
      console.log("MFB-error-logs ~ rider assignment push ~ err:", err.message);
    }

    return {
      ok: true,
      dp_id: partner.dp_id,
      do_id: result.do_id,
      assigned: true,
      pushed,
      // Not silent when offline: an assignment to a rider who is not online is
      // legitimate (they may be about to start a shift) but the operator should
      // know the phone will not ring right now.
      reason: partner.dp_online
        ? result.reason
        : `${result.reason} — rider is offline, they will see it when they go online`,
      ...(pushReason ? { push_error: pushReason } : {}),
    };
  } catch (err) {
    console.log("MFB-error-logs ~ assignToPanelRider ~ err:", err.message);
    return { ok: false, reason: `assignment failed: ${err.message}` };
  }
}

module.exports = { assignToPanelRider };
