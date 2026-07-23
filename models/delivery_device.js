const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Registered push devices for a delivery partner. Its own delivery collection
// (store_delivery_devices) — one row per FCM registration token. A partner can
// have several (phone + tablet, reinstalls); dead tokens are pruned on send.
const DeliveryDevice = sequelize.define(
  "delivery_device",
  {
    device_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    // FCM registration token (unique across the table).
    token: { type: DataTypes.STRING(255), allowNull: false },
    // android | ios
    platform: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "android" },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
    last_seen: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_delivery_devices",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "device_id" }] },
      { name: "dd_token_uniq", unique: true, using: "BTREE", fields: [{ name: "token" }] },
      { name: "dd_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
    ],
  }
);

module.exports = DeliveryDevice;
