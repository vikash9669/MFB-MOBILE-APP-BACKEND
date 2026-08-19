const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Customer in-app alerts (store_user_notifications), separate from the
// delivery-partner notifications. Backs the bell/notification-centre in the
// customer app; also mirrored out as an FCM push when raised.
const UserNotification = sequelize.define(
  "user_notification",
  {
    notif_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    // orders | offers | wallet | system
    category: {
      type: DataTypes.ENUM("orders", "offers", "wallet", "system"),
      allowNull: false,
      defaultValue: "system",
    },
    // Material icon name the app renders.
    icon: { type: DataTypes.STRING(40), allowNull: true },
    title: { type: DataTypes.STRING(160), allowNull: false },
    body: { type: DataTypes.STRING(255), allowNull: true },
    // Optional deep-link target (order the alert refers to).
    ref_order_id: { type: DataTypes.INTEGER, allowNull: true },
    is_read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_user_notifications",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "notif_id" }] },
      { name: "un_user_idx", using: "BTREE", fields: [{ name: "user_id" }] },
    ],
  }
);

module.exports = UserNotification;
