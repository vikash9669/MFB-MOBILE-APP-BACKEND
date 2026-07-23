const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Append-only timeline of a delivery job's status changes. Separate delivery
// collection (store_delivery_order_events) — the delivery app's audit log,
// independent of the customer app's store_orders_log.
const DeliveryOrderEvent = sequelize.define(
  "delivery_order_event",
  {
    event_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    do_id: { type: DataTypes.INTEGER, allowNull: false },
    dp_id: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false },
    note: { type: DataTypes.STRING(255), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_delivery_order_events",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "event_id" }] },
      { name: "doe_order_idx", using: "BTREE", fields: [{ name: "do_id" }] },
    ],
  }
);

module.exports = DeliveryOrderEvent;
