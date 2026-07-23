const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// Partner shift schedule. Own delivery collection (store_delivery_shifts).
const DeliveryShift = sequelize.define(
  "delivery_shift",
  {
    shift_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    // Calendar day the shift falls on (YYYY-MM-DD).
    shift_date: { type: DataTypes.DATEONLY, allowNull: false },
    start_time: { type: DataTypes.STRING(8), allowNull: false }, // "18:00"
    end_time: { type: DataTypes.STRING(8), allowNull: false }, // "22:00"
    label: { type: DataTypes.STRING(60), allowNull: true }, // "Evening peak"
    // available (bookable) | booked | active (running now) | completed
    status: {
      type: DataTypes.ENUM("available", "booked", "active", "completed"),
      allowNull: false,
      defaultValue: "available",
    },
    worked_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    break_left_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    login_bonus: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    // Extra incentive advertised for peak/surge shifts (e.g. +₹300).
    incentive_bonus: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "store_delivery_shifts",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "shift_id" }] },
      { name: "ds_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
    ],
  }
);

module.exports = DeliveryShift;
