const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Delivery jobs live in their OWN table (store_delivery_orders), kept separate
// from the customer app's store_orders. A row may optionally reference the
// customer order it originated from (source_order_id) but all delivery-partner
// state — assignment, OTPs, proof, per-order earnings, cash — is owned here so
// the delivery app never writes into the customer/vendor collections.
const DeliveryOrder = sequelize.define(
  "delivery_order",
  {
    do_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    // Assigned partner. NULL while the job is still being offered to riders.
    dp_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Optional back-reference to the customer app's store_orders.order_id.
    source_order_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Human-friendly reference shown in the UI (e.g. "4821").
    order_ref: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    // offered → accepted → picked_up → delivered ; or rejected / cancelled.
    status: {
      type: DataTypes.ENUM(
        "offered",
        "accepted",
        "picked_up",
        "delivered",
        "cancelled",
        "rejected"
      ),
      allowNull: false,
      defaultValue: "offered",
    },
    // ── Pickup (restaurant) ──────────────────────────────────────────
    pickup_name: { type: DataTypes.STRING(120), allowNull: false },
    pickup_address: { type: DataTypes.STRING(255), allowNull: true },
    pickup_area: { type: DataTypes.STRING(120), allowNull: true },
    pickup_phone: { type: DataTypes.STRING(15), allowNull: true },
    pickup_lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    pickup_lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    pickup_otp: { type: DataTypes.STRING(6), allowNull: false },
    pickup_distance_km: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
    ready_in_min: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 4 },
    // ── Drop (customer) ──────────────────────────────────────────────
    drop_name: { type: DataTypes.STRING(120), allowNull: false },
    drop_address: { type: DataTypes.STRING(255), allowNull: true },
    drop_area: { type: DataTypes.STRING(120), allowNull: true },
    drop_phone: { type: DataTypes.STRING(15), allowNull: true },
    drop_lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    drop_lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    drop_otp: { type: DataTypes.STRING(6), allowNull: false },
    drop_note: { type: DataTypes.STRING(255), allowNull: true },
    // ── Order details ────────────────────────────────────────────────
    items_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    distance_km: { type: DataTypes.DECIMAL(5, 1), allowNull: false, defaultValue: 0 },
    eta_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // ── Payment ──────────────────────────────────────────────────────
    payment_type: {
      type: DataTypes.ENUM("COD", "PG"),
      allowNull: false,
      defaultValue: "COD",
    },
    cash_to_collect: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cash_collected: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: 0 },
    // ── Earnings breakdown for this job ──────────────────────────────
    earn_base: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    earn_distance: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    earn_surge: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    earn_tip: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    earn_total: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    // Proof-of-delivery photo reference (data URI / URL / storage key).
    proof_photo: { type: DataTypes.TEXT, allowNull: true },
    // ── Timestamps ───────────────────────────────────────────────────
    offered_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
    accepted_at: { type: DataTypes.DATE, allowNull: true },
    picked_up_at: { type: DataTypes.DATE, allowNull: true },
    delivered_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "store_delivery_orders",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "do_id" }] },
      { name: "do_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
      { name: "do_status_idx", using: "BTREE", fields: [{ name: "status" }] },
    ],
  }
);

module.exports = DeliveryOrder;
