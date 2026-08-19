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
const crypto = require("crypto");
const { User, DeliveryPartner } = require("../models");

const RIDER_ROLE = 3;

const normalizePhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/** The panel-side rider for a partner, or null if there isn't one yet. */
async function findPanelRider(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return User.findOne({ where: { user_phone: p } });
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
  const phone = normalizePhone(partner.dp_phone);
  if (!phone) return { rider: null, created: false, reason: "no phone" };

  const existing = await findPanelRider(phone);
  if (existing) {
    // Deliberately not mutating: the row may be a customer or an existing
    // rider, and silently rewriting somebody's role is exactly the kind of
    // change that breaks old behaviour.
    return {
      rider: existing,
      created: false,
      reason:
        Number(existing.user_role) === RIDER_ROLE
          ? "already a panel rider"
          : `phone belongs to an account with user_role ${existing.user_role}`,
    };
  }

  const name = String(partner.dp_name || "").trim() || `Rider ${phone.slice(-4)}`;
  const rider = await User.create({
    user_role: RIDER_ROLE,
    user_name: name.slice(0, 40),
    user_email: partner.dp_email || `dp${partner.dp_id}@example.com`,
    user_phone: phone,
    user_phone_1: phone,
    user_otp: "000000",
    user_code: `D${Date.now().toString().slice(-8)}`,
    user_manager: 0,
    user_landmark: "",
    user_city: "1",
    user_state: 1,
    user_zip: "000000",
    user_location: 0,
    user_password: crypto.randomBytes(24).toString("hex"),
    user_registered: new Date(),
    user_login: 0,
    // Approved in the app, so listed and able to take orders straight away.
    user_active: 1,
    user_status: 1,
  });

  return { rider, created: true, reason: "created from an approved partner" };
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
    attributes: ["dp_id", "dp_phone", "dp_verification_status", "dp_online"],
  });
  return (
    partners.find((p) => normalizePhone(p.dp_phone) === phone) ?? null
  );
}

/** phone → store_users.user_id, for a batch of partner phones. One query. */
async function panelRiderIdsByPhone(phones) {
  const list = [...new Set(phones.map(normalizePhone).filter(Boolean))];
  if (list.length === 0) return new Map();
  const rows = await User.findAll({
    where: { user_phone: list },
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
