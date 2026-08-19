const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// store_users_cashback — the ledger administration/Ajax::Status settled when an
// order reached status 3. Each row is cashback a customer earned on one order;
// cashback_status 0 = pending, 1 = credited to store_users.user_cashback.
const Cashback = sequelize.define(
  "cashback",
  {
    cashback_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    order_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    referral_id: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cashback_earned: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cashback_balance: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    cashback_type: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    cashback_status: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    cashback_time: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: "store_users_cashback",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "cashback_id" }] },
      { name: "user_id", using: "BTREE", fields: [{ name: "user_id" }] },
      { name: "order_id", using: "BTREE", fields: [{ name: "order_id" }] },
    ],
  }
);

module.exports = Cashback;
