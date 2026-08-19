const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Registered push devices for a CUSTOMER (store_users). Own collection
// (store_user_devices), separate from the delivery-partner devices. One row per
// FCM registration token; a customer may have several (phone + tablet,
// reinstalls). Dead tokens are pruned on send.
const UserDevice = sequelize.define(
  "user_device",
  {
    device_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // FCM registration token (unique across the table).
    token: { type: DataTypes.STRING(255), allowNull: false },
    // android | ios
    platform: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "android" },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
    last_seen: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_user_devices",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "device_id" }] },
      { name: "ud_token_uniq", unique: true, using: "BTREE", fields: [{ name: "token" }] },
      { name: "ud_user_idx", using: "BTREE", fields: [{ name: "user_id" }] },
    ],
  }
);

module.exports = UserDevice;
