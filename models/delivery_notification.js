const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Partner in-app alerts. Own delivery collection (store_delivery_notifications).
const DeliveryNotification = sequelize.define(
  "delivery_notification",
  {
    notif_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    // orders | payments | bonuses | system
    category: {
      type: DataTypes.ENUM("orders", "payments", "bonuses", "system"),
      allowNull: false,
      defaultValue: "system",
    },
    // Material icon name the app renders.
    icon: { type: DataTypes.STRING(40), allowNull: true },
    title: { type: DataTypes.STRING(160), allowNull: false },
    body: { type: DataTypes.STRING(255), allowNull: true },
    is_read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_delivery_notifications",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "notif_id" }] },
      { name: "dn_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
    ],
  }
);

module.exports = DeliveryNotification;
