// Bridges the two halves of the rider system.
//
// A rider exists in two places that grew up separately:
//
//   store_users (user_role = 3)   the panel's rider — order assignment
//                                 (store_orders.rider_id), reports, the /rider
//                                 web portal, the Riders list.
//   store_delivery_partners       the delivery app's partner — OTP login,
//                                 KYC, wallet, shifts, delivery_orders.dp_id.
//
// There is no foreign key between them, so a partner approved in the app was
// invisible to every panel screen and could not be assigned an order. The two
// are one person, and the phone number is the identity in both systems (both
// sign in by phone), so it is the join key.
//
// Nothing here modifies an existing account. If a store_users row already has
// the phone it is linked as-is; only a genuinely absent rider is created. That
// keeps the old panel behaviour untouched — this only ever adds.
const { User, DeliveryPartner } = require("../models");

const RIDER_ROLE = 3;

const normalizePhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/** The panel-side rider for a partner, or null if there isn't one yet. */
async function findPanelRider(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  // Since the tables were unified this is the partner's own row — the lookup
  // survives because plenty of callers still ask by phone.
  // Role-scoped, not phone-only. A phone very often already belongs to a
  // customer account — the same person ordered food before applying to
  // deliver it — and matching that row made a pending application look
  // already-linked. The panel drops linked applications from its "needs a
  // decision" list and shows the roster of user_role 3, so the applicant
  // appeared in neither and was invisible to staff.
  return User.findOne({ where: { user_phone: p, user_role: RIDER_ROLE } });
}


/**
 * Ensures the approved partner also exists as a panel rider, and returns it.
 *
 * Creating one mirrors controllers/admin/register.js so the row is
 * indistinguishable from a rider registered the normal way.
 *
 * The password is random and never shown to anyone: the partner signs in to the
 * app with an OTP, and this row exists so the panel can see and assign them. It
 * is deliberately unusable as a login rather than left blank, which would be a
 * password of "" against the plaintext comparison in admin/auth.js.
 */
async function ensurePanelRider(partner) {
  // Nothing to create any more: a partner IS the store_users rider row, so the
  // roster, order assignment and reports can all see them the moment they sign
  // up. This used to create a parallel store_users row on approval, and
  // refused when the phone already belonged to a customer — which is how an
  // approved partner could end up invisible to every panel screen.
  //
  // Kept as a function because approval still calls it and still wants the
  // rider back; it now just confirms the row is really a rider.
  const phone = normalizePhone(partner.dp_phone);
  if (!phone) return { rider: null, created: false, reason: "no phone" };

  const rider = await findPanelRider(phone);
  if (rider) return { rider, created: false, reason: "partner is the panel rider" };

  // Only reachable if something changed the row's role out from under us.
  return {
    rider: null,
    created: false,
    reason: `no store_users row with user_role ${RIDER_ROLE} for this partner`,
  };
}

/**
 * Opens or closes the panel rider's access, following a verification decision.
 *
 * Rejecting an already-approved partner has to reach the panel side too, or
 * they stay Listed and Active and can still be handed orders while locked out
 * of their own app. Re-approving restores both.
 *
 * Only ever touches a rider (user_role 3). A phone can belong to a customer —
 * their shopping account must not be disabled because a delivery application
 * was rejected.
 */
async function setPanelRiderAccess(partner, allowed) {
  const rider = await findPanelRider(partner.dp_phone);
  if (!rider) return { changed: false, reason: "no panel rider" };
  if (Number(rider.user_role) !== RIDER_ROLE) {
    return {
      changed: false,
      reason: `left alone — user_role ${rider.user_role}, not a rider`,
    };
  }
  const next = { user_active: allowed ? 1 : 0, user_status: allowed ? 1 : 0 };
  if (
    Number(rider.user_active) === next.user_active &&
    Number(rider.user_status) === next.user_status
  ) {
    return { changed: false, reason: "already in that state", rider };
  }
  await rider.update(next);
  return {
    changed: true,
    rider,
    reason: allowed ? "listed and enabled" : "delisted and disabled",
  };
}

/**
 * The delivery-app partner behind a panel rider, or null.
 *
 * The mirror of findPanelRider, and the direction the panel needs: an operator
 * assigning an order picks a store_users rider, but everything the rider app
 * reads is keyed by dp_id. Without this the assignment lands in
 * store_orders.rider_id and stops there — the rider is "assigned" on screen and
 * the app never hears about it.
 *
 * Same phone join, same caveats: one number, one person.
 */
async function findPartnerForPanelRider(userId) {
  const rider = await User.findByPk(userId, {
    attributes: ["user_id", "user_phone"],
  });
  if (rider == null) return null;
  const phone = normalizePhone(rider.user_phone);
  if (!phone) return null;
  // dp_phone is not normalised on the way in, so match on the last 10 digits
  // the same way findPanelRider does rather than trusting an exact string.
  const partners = await DeliveryPartner.findAll({
    // dp_name so a panel assignment can tell the customer who is coming —
    // util/riderAssignment.js passes it straight to orderCustomerNotify.
    attributes: ["dp_id", "dp_name", "dp_phone", "dp_verification_status", "dp_online"],
  });
  return (
    partners.find((p) => normalizePhone(p.dp_phone) === phone) ?? null
  );
}

/** phone → store_users.user_id, for a batch of partner phones. One query. */
async function panelRiderIdsByPhone(phones) {
  const list = [...new Set(phones.map(normalizePhone).filter(Boolean))];
  if (list.length === 0) return new Map();
  // Role-scoped for the same reason as findPanelRider: a customer account on
  // the same number is not a panel rider, and treating it as one hides the
  // application from the review queue.
  const rows = await User.findAll({
    where: { user_phone: list, user_role: RIDER_ROLE },
    attributes: ["user_id", "user_phone"],
    raw: true,
  });
  return new Map(rows.map((r) => [normalizePhone(r.user_phone), r.user_id]));
}

module.exports = {
  ensurePanelRider,
  setPanelRiderAccess,
  findPanelRider,
  findPartnerForPanelRider,
  panelRiderIdsByPhone,
  normalizePhone,
  RIDER_ROLE,
};
