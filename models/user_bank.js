const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// Vendor / rider payout details, shown on the admin panel's user detail pages.
const UserBank = sequelize.define(
  "user_bank",
  {
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    bank_name: { type: DataTypes.STRING(255), allowNull: true },
    bank_account_name: { type: DataTypes.STRING(40), allowNull: false },
    bank_account: { type: DataTypes.STRING(30), allowNull: true },
    bank_ifsc: { type: DataTypes.STRING(11), allowNull: true },
    bank_status: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: "store_users_bank",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "id" }] },
      { name: "user_id", using: "BTREE", fields: [{ name: "user_id" }] },
    ],
  }
);

module.exports = UserBank;
