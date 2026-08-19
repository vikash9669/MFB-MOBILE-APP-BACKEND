// Pushes the delivery app's progress back onto the legacy order.
//
// store_orders.order_status is the panel's whole view of an order, and every
// operational screen reads it: the Orders list, the dashboard counters, the
// reports. store_delivery_orders.status is the rider's. They describe the same
// journey and were never connected, so a rider could collect the food and hand
// it over while the panel still said "Ready to Ship" — the customer app showed
// "On the way" (it reads the delivery job) and staff looking at the panel saw a
// different reality from the customer they were about to be phoned by.
//
// Only ever moves an order FORWARD. A delivery event arriving late must not
// drag a Delivered order back to On the Way, and nothing here may resurrect a
// cancelled one — a refund may already have gone out.
const sequelize = require("./database");
const { QueryTypes } = require("sequelize");
const { StoreOrderLogs } = require("../models");

// Legacy status codes — controllers/admin/dashboard.js STATUS_LABELS.
const ON_THE_WAY = 4;
const DELIVERED = 5;
const CANCELLED = 6;

/** Delivery-job status → the legacy status it implies. */
const MAPPING = {
  picked_up: ON_THE_WAY,
  delivered: DELIVERED,
};

/**
 * The store_users id recorded against an automatic transition.
 *
 * The history table takes a user_id and the rider has one on the panel side,
 * so the trail reads "On the Way by <rider>" rather than attributing a rider's
 * action to whichever admin happened to be logged in.
 */
async function riderUserId(dpId) {
  if (!dpId) return null;
  try {
    const { findPanelRider } = require("./riderLink");
    const { DeliveryPartner } = require("../models");
    const partner = await DeliveryPartner.findByPk(dpId);
    if (partner == null) return null;
    const rider = await findPanelRider(partner.dp_phone);
    return rider?.user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Advances the legacy order to match a delivery-job event.
 *
 * Never throws — a rider confirming a pickup must not fail because the panel's
 * mirror could not be updated.
 *
 * Returns { synced, status, reason }.
 */
async function syncFromDelivery(sourceOrderId, deliveryStatus, { dpId } = {}) {
  try {
    const target = MAPPING[deliveryStatus];
    if (target == null) {
      return { synced: false, reason: `no legacy status maps to "${deliveryStatus}"` };
    }
    if (!sourceOrderId) {
      // Demo/seeded jobs have no real order behind them.
      return { synced: false, reason: "delivery job has no source order" };
    }

    // Forward-only, and never out of Cancelled. Expressed in the WHERE clause
    // rather than checked first, so two events landing together cannot both
    // decide they are the one moving the row.
    const [, affected] = await sequelize.query(
      `UPDATE \`store_orders\`
          SET \`order_status\` = :target
              ${target === DELIVERED ? ", `order_delivered_time` = COALESCE(`order_delivered_time`, UTC_TIMESTAMP())" : ""}
        WHERE \`order_id\` = :orderId
          AND \`order_status\` < :target
          AND \`order_status\` <> :cancelled`,
      {
        replacements: { orderId: sourceOrderId, target, cancelled: CANCELLED },
        type: QueryTypes.UPDATE,
      }
    );

    if (Number(affected ?? 0) === 0) {
      return {
        synced: false,
        reason: "order was already at or past this status, or is cancelled",
      };
    }

    // Same trail an admin's click leaves, so the History card explains why the
    // status moved without anyone touching the panel.
    try {
      await StoreOrderLogs.create({
        order_id: sourceOrderId,
        user_id: await riderUserId(dpId),
        order_status: target,
      });
    } catch (err) {
      console.log("MFB-error-logs ~ order sync ~ history ~", err.message);
    }

    return { synced: true, status: target };
  } catch (err) {
    console.log("MFB-error-logs ~ order sync ~ err:", err.message);
    return { synced: false, reason: err.message };
  }
}

module.exports = { syncFromDelivery, ON_THE_WAY, DELIVERED };
