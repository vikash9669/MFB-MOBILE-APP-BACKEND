// Demo data provisioner for the delivery-partner app.
//
// Populates a partner's OWN delivery collections (orders, shifts, documents,
// wallet, notifications) so the app shows meaningful content end-to-end. This
// only writes to store_delivery_* tables — never the customer/vendor tables.
//
// Used two ways:
//   • lazily on first login, but ONLY when DELIVERY_DEMO is explicitly "true",
//     so a fresh partner gets a working app in dev;
//   • via `npm run seed:delivery -- <phone>` to (re)seed a specific partner.
const {
  DeliveryPartner,
  DeliveryOrder,
  DeliveryOrderEvent,
  DeliveryWalletTxn,
  DeliveryShift,
  DeliveryDocument,
  DeliveryNotification,
} = require("../models");
const { genOtp } = require("./delivery");

const RESTAURANTS = [
  { name: "Burger Republic", area: "South Tukoganj" },
  { name: "Pizza Fort", area: "Vijay Nagar" },
  { name: "Biryani House", area: "Palasia" },
  { name: "Wok & Roll", area: "New Palasia" },
  { name: "The Sandwich Co.", area: "Saket" },
];
const CUSTOMERS = [
  { name: "Aditya", area: "Scheme 54" },
  { name: "Neha", area: "Bengali Square" },
  { name: "Rohit", area: "Sudama Nagar" },
  { name: "Priya", area: "Nipania" },
  { name: "Karan", area: "Rau" },
];

const pick = (arr, i) => arr[i % arr.length];
const rint = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// Builds one delivery-order payload with a plausible earnings breakdown.
const buildOrder = (i, status, deliveredAt) => {
  const store = pick(RESTAURANTS, i);
  const cust = pick(CUSTOMERS, i + 2);
  const distance = +(1.5 + Math.random() * 4).toFixed(1);
  const base = rint(40, 55);
  const distancePay = Math.round(distance * 10);
  const surge = Math.random() < 0.35 ? rint(20, 60) : 0;
  const tip = Math.random() < 0.45 ? rint(10, 40) : 0;
  const total = base + distancePay + surge + tip;
  const isCod = Math.random() < 0.5;

  const picked = deliveredAt ? new Date(deliveredAt.getTime() - rint(12, 20) * 60000) : null;

  return {
    dp_id: null,
    order_ref: String(4800 + i),
    status,
    pickup_name: store.name,
    pickup_area: store.area,
    pickup_address: `${store.name}, ${store.area}`,
    pickup_phone: `98${rint(10000000, 99999999)}`,
    pickup_lat: 22.72 + Math.random() * 0.04,
    pickup_lng: 75.85 + Math.random() * 0.04,
    pickup_otp: genOtp(),
    pickup_distance_km: +(0.5 + Math.random() * 2).toFixed(1),
    ready_in_min: rint(2, 8),
    drop_name: cust.name,
    drop_area: cust.area,
    drop_address: `${cust.name}, ${cust.area}`,
    drop_phone: `97${rint(10000000, 99999999)}`,
    drop_lat: 22.72 + Math.random() * 0.05,
    drop_lng: 75.85 + Math.random() * 0.05,
    drop_otp: genOtp(),
    drop_note: i % 3 === 0 ? "Gate 2, ring bell twice. Leave at door if no answer." : null,
    items_count: rint(1, 4),
    distance_km: distance,
    eta_min: rint(9, 22),
    payment_type: isCod ? "COD" : "PG",
    cash_to_collect: isCod ? rint(180, 600) : 0,
    cash_collected: false,
    earn_base: base,
    earn_distance: distancePay,
    earn_surge: surge,
    earn_tip: tip,
    earn_total: total,
    offered_at: picked || new Date(),
    accepted_at: picked,
    picked_up_at: picked,
    delivered_at: deliveredAt,
  };
};

// Removes a partner's existing demo rows so a re-seed starts clean.
const wipePartner = async (dpId) => {
  const orders = await DeliveryOrder.findAll({ where: { dp_id: dpId }, attributes: ["do_id"] });
  const ids = orders.map((o) => o.do_id);
  if (ids.length) {
    await DeliveryOrderEvent.destroy({ where: { do_id: ids } });
  }
  await DeliveryOrder.destroy({ where: { dp_id: dpId } });
  await DeliveryWalletTxn.destroy({ where: { dp_id: dpId } });
  await DeliveryShift.destroy({ where: { dp_id: dpId } });
  await DeliveryDocument.destroy({ where: { dp_id: dpId } });
  await DeliveryNotification.destroy({ where: { dp_id: dpId } });
};

const dateOnly = (d) => d.toISOString().slice(0, 10);

async function provisionDemoData(partner, { force = false } = {}) {
  const dpId = partner.dp_id;

  const existing = await DeliveryDocument.count({ where: { dp_id: dpId } });
  if (existing > 0 && !force) {
    return { seeded: false };
  }
  if (force) {
    await wipePartner(dpId);
  }

  // ── Partner profile / stats ──────────────────────────────────────
  await partner.update({
    // Demo/seeded partners are pre-approved so the app is usable immediately.
    dp_verification_status: "approved",
    dp_name: partner.dp_name || "Rahul Kumar",
    dp_email: partner.dp_email || "rahul.partner@myfirstbite.in",
    dp_vehicle_type: "Bike",
    dp_vehicle_number: "MP09 AB 1234",
    dp_rating: 4.9,
    dp_total_deliveries: 2184,
    dp_on_time_pct: 98,
    dp_acceptance_pct: 94,
    dp_completion_pct: 99,
    dp_cancellation_pct: 1.2,
    dp_avg_delivery_min: 17,
    dp_wallet_balance: 0,
    dp_cash_in_hand: 0,
  });

  // ── Delivered orders: today (for Home + Earnings) ────────────────
  // Spread delivered_at across the elapsed part of today (midnight → now) so
  // the orders always count as "today" no matter when the seed runs.
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const elapsedMs = Math.max(60000, now.getTime() - midnight.getTime());
  const todaysOrders = [];
  const todayCount = 11;
  for (let i = 0; i < todayCount; i += 1) {
    const at = new Date(midnight.getTime() + Math.floor(Math.random() * elapsedMs));
    todaysOrders.push(buildOrder(i, "delivered", at));
  }
  // ── Delivered orders: previous 6 days (for the weekly chart) ─────
  const pastOrders = [];
  for (let d = 1; d <= 6; d += 1) {
    for (let k = 0; k < rint(3, 9); k += 1) {
      const at = new Date(now);
      at.setDate(now.getDate() - d);
      at.setHours(rint(11, 22), rint(0, 59), 0, 0);
      pastOrders.push(buildOrder(100 + d * 10 + k, "delivered", at));
    }
  }

  const created = await DeliveryOrder.bulkCreate(
    [...todaysOrders, ...pastOrders].map((o) => ({ ...o, dp_id: dpId })),
    { returning: true }
  );

  // Mark COD orders as cash-collected and tally cash-in-hand + wallet balance.
  let walletBalance = 0;
  let cashInHand = 0;
  for (const o of created) {
    walletBalance += Number(o.earn_total);
    if (o.payment_type === "COD") {
      cashInHand += Number(o.cash_to_collect);
    }
  }
  await DeliveryOrder.update(
    { cash_collected: true },
    { where: { dp_id: dpId, payment_type: "COD", status: "delivered" } }
  );

  // ── An unassigned job waiting in the offered pool (Incoming screen) ─
  // Only add one if the shared pool is currently empty, to avoid pile-up.
  const offeredCount = await DeliveryOrder.count({ where: { status: "offered", dp_id: null } });
  if (offeredCount === 0) {
    await DeliveryOrder.create({ ...buildOrder(7, "offered", null), dp_id: null });
  }

  // ── Wallet ledger (display) + running balance ────────────────────
  const recent = created[0];
  const withdrawal = 3420;
  await DeliveryWalletTxn.bulkCreate([
    {
      dp_id: dpId,
      type: "earning",
      direction: "credit",
      amount: Number(recent.earn_total),
      title: `Order #${recent.order_ref} earning`,
      ref_order_id: recent.do_id,
      status: "settled",
      created_at: recent.delivered_at,
    },
    {
      dp_id: dpId,
      type: "withdrawal",
      direction: "debit",
      amount: withdrawal,
      title: "Bank withdrawal",
      description: "Sent to HDFC ••4821",
      status: "settled",
      created_at: new Date(now.getTime() - 2 * 3600000),
    },
    {
      dp_id: dpId,
      type: "incentive",
      direction: "credit",
      amount: 450,
      title: "Weekly incentive",
      status: "settled",
      created_at: new Date(now.getTime() - 20 * 3600000),
    },
    {
      dp_id: dpId,
      type: "earning",
      direction: "credit",
      amount: 640,
      title: "Pending settlement",
      status: "pending",
      created_at: new Date(now.getTime() - 30 * 60000),
    },
  ]);
  // Net settled balance = lifetime earnings + incentive − withdrawal.
  await partner.update({
    dp_wallet_balance: Math.max(0, walletBalance + 450 - withdrawal),
    dp_cash_in_hand: cashInHand,
  });

  // ── Shifts ───────────────────────────────────────────────────────
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const daysUntilSat = (6 - now.getDay() + 7) % 7 || 7;
  const saturday = new Date(now);
  saturday.setDate(now.getDate() + daysUntilSat);

  const shiftRows = [
    {
      dp_id: dpId,
      shift_date: dateOnly(now),
      start_time: "18:00",
      end_time: "22:00",
      label: "Evening peak",
      status: "active",
      worked_min: 192,
      break_left_min: 22,
      login_bonus: 120,
      incentive_bonus: 0,
    },
    {
      dp_id: dpId,
      shift_date: dateOnly(tomorrow),
      start_time: "08:00",
      end_time: "12:00",
      label: "Morning",
      status: "booked",
      worked_min: 0,
      login_bonus: 80,
      incentive_bonus: 0,
    },
    {
      dp_id: dpId,
      shift_date: dateOnly(saturday),
      start_time: "19:00",
      end_time: "23:00",
      label: "Dinner peak",
      status: "available",
      worked_min: 0,
      login_bonus: 100,
      incentive_bonus: 300,
    },
  ];
  // A couple of completed shifts earlier this week for the strip / booked hours.
  for (let d = 1; d <= 2; d += 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - d);
    if (day.getDay() !== 0) {
      shiftRows.push({
        dp_id: dpId,
        shift_date: dateOnly(day),
        start_time: "18:00",
        end_time: "22:00",
        label: "Evening peak",
        status: "completed",
        worked_min: 240,
        login_bonus: 120,
        incentive_bonus: 0,
      });
    }
  }
  await DeliveryShift.bulkCreate(shiftRows);

  // ── Documents (KYC) ──────────────────────────────────────────────
  const licenceExpiry = new Date(now);
  licenceExpiry.setDate(now.getDate() + 18);
  await DeliveryDocument.bulkCreate([
    { dp_id: dpId, doc_type: "license", title: "Driving licence", status: "expiring", expires_on: dateOnly(licenceExpiry) },
    { dp_id: dpId, doc_type: "pan", title: "PAN card", status: "active" },
    { dp_id: dpId, doc_type: "aadhaar", title: "Aadhaar", status: "active" },
    { dp_id: dpId, doc_type: "rc", title: "Vehicle RC", status: "active" },
    { dp_id: dpId, doc_type: "insurance", title: "Insurance", status: "pending" },
  ]);

  // ── Notifications ────────────────────────────────────────────────
  await DeliveryNotification.bulkCreate([
    { dp_id: dpId, category: "payments", icon: "payments", title: "Payout of ₹3,420 settled", body: "Sent to HDFC ••4821", is_read: false, created_at: new Date(now.getTime() - 12 * 60000) },
    { dp_id: dpId, category: "bonuses", icon: "emoji_events", title: "You unlocked the ₹150 bonus 🎉", body: "13 orders today", is_read: false, created_at: new Date(now.getTime() - 3600000) },
    { dp_id: dpId, category: "system", icon: "description", title: "Driving license expires in 18 days", body: "Re-upload to avoid pause", is_read: false, created_at: new Date(now.getTime() - 3 * 3600000) },
    { dp_id: dpId, category: "system", icon: "campaign", title: "New: rain bonus is now ₹25/order", body: "Announcement", is_read: true, created_at: new Date(now.getTime() - 26 * 3600000) },
  ]);

  return { seeded: true, orders: created.length };
}

// Best-effort lazy seed on first login. Never throws into the auth flow.
//
// OPT-IN, deliberately. This used to seed unless DELIVERY_DEMO was the exact
// string "false", which meant a deploy that simply forgot the variable — or
// mistyped it, or set it to "0" — fabricated orders, earnings and a
// pre-approved KYC status onto a real partner's first login, and bypassed the
// onboarding gate while doing it. Fabricated earnings on a live rider's wallet
// is not a failure mode worth leaving one typo away, so the default is now off
// and demo data takes a deliberate "true".
const demoEnabled = () => String(process.env.DELIVERY_DEMO).toLowerCase().trim() === "true";

async function maybeProvisionOnLogin(partner) {
  if (!demoEnabled()) {
    return;
  }
  try {
    await provisionDemoData(partner);
  } catch (err) {
    console.log("MFB-error-logs ~ delivery demo provision ~ err:", err.message);
  }
}

module.exports = { provisionDemoData, maybeProvisionOnLogin, demoEnabled, DeliveryPartner };
