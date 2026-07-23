// Shared helpers for the delivery-partner APIs: JSON serializers (so every
// endpoint returns the same shape the app expects) plus small ledger helpers
// for the wallet and order-event collections.
const {
  DeliveryWalletTxn,
  DeliveryOrderEvent,
  DeliveryPartner,
} = require("../models");

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// Six-digit numeric OTP for pickup / delivery confirmation.
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

// Public profile shape (Home header, Profile screen, tokens).
const serializePartner = (p) => ({
  dp_id: p.dp_id,
  name: p.dp_name || "",
  email: p.dp_email || "",
  phone: p.dp_phone,
  code: p.dp_code,
  role: "delivery_partner",
  vehicle_type: p.dp_vehicle_type,
  vehicle_number: p.dp_vehicle_number,
  online: !!p.dp_online,
  wallet_balance: num(p.dp_wallet_balance),
  cash_in_hand: num(p.dp_cash_in_hand),
  rating: num(p.dp_rating),
  total_deliveries: num(p.dp_total_deliveries),
  on_time_pct: num(p.dp_on_time_pct),
  acceptance_pct: num(p.dp_acceptance_pct),
  completion_pct: num(p.dp_completion_pct),
  cancellation_pct: num(p.dp_cancellation_pct),
  avg_delivery_min: num(p.dp_avg_delivery_min),
  settings: p.dp_settings || {},
});

// Full order shape used by the order-flow screens.
const serializeOrder = (o) => ({
  do_id: o.do_id,
  order_ref: o.order_ref,
  status: o.status,
  pickup: {
    name: o.pickup_name,
    address: o.pickup_address,
    area: o.pickup_area,
    phone: o.pickup_phone,
    lat: o.pickup_lat != null ? num(o.pickup_lat) : null,
    lng: o.pickup_lng != null ? num(o.pickup_lng) : null,
    distance_km: num(o.pickup_distance_km),
    ready_in_min: num(o.ready_in_min),
  },
  drop: {
    name: o.drop_name,
    address: o.drop_address,
    area: o.drop_area,
    phone: o.drop_phone,
    lat: o.drop_lat != null ? num(o.drop_lat) : null,
    lng: o.drop_lng != null ? num(o.drop_lng) : null,
    note: o.drop_note,
  },
  items_count: num(o.items_count),
  distance_km: num(o.distance_km),
  eta_min: num(o.eta_min),
  payment_type: o.payment_type,
  cash_to_collect: num(o.cash_to_collect),
  cash_collected: !!o.cash_collected,
  earnings: {
    base: num(o.earn_base),
    distance: num(o.earn_distance),
    surge: num(o.earn_surge),
    tip: num(o.earn_tip),
    total: num(o.earn_total),
  },
  offered_at: o.offered_at,
  accepted_at: o.accepted_at,
  picked_up_at: o.picked_up_at,
  delivered_at: o.delivered_at,
});

const serializeTxn = (t) => ({
  txn_id: t.txn_id,
  type: t.type,
  direction: t.direction,
  amount: num(t.amount),
  title: t.title,
  description: t.description,
  ref_order_id: t.ref_order_id,
  status: t.status,
  created_at: t.created_at,
});

// Records a wallet ledger entry and keeps the partner's running balance in sync.
// Credits increase the balance; debits decrease it.
const recordWalletTxn = async (dpId, { type, direction, amount, title, description, ref_order_id, status }) => {
  const txn = await DeliveryWalletTxn.create({
    dp_id: dpId,
    type,
    direction,
    amount,
    title,
    description: description || null,
    ref_order_id: ref_order_id || null,
    status: status || "settled",
  });

  // Only settled entries move the withdrawable balance.
  if ((status || "settled") === "settled") {
    const delta = direction === "credit" ? num(amount) : -num(amount);
    await DeliveryPartner.increment("dp_wallet_balance", { by: delta, where: { dp_id: dpId } });
  }
  return txn;
};

// Appends an entry to a delivery order's timeline.
const logOrderEvent = (doId, dpId, status, note) =>
  DeliveryOrderEvent.create({ do_id: doId, dp_id: dpId || null, status, note: note || null });

module.exports = {
  num,
  genOtp,
  serializePartner,
  serializeOrder,
  serializeTxn,
  recordWalletTxn,
  logOrderEvent,
};
