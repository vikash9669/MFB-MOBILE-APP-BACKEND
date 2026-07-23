const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Partner wallet ledger — earnings, withdrawals, incentives, adjustments.
// Own delivery collection (store_delivery_wallet_txns), fully separate from any
// customer-app payment tables.
const DeliveryWalletTxn = sequelize.define(
  "delivery_wallet_txn",
  {
    txn_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    // earning | withdrawal | incentive | adjustment
    type: {
      type: DataTypes.ENUM("earning", "withdrawal", "incentive", "adjustment"),
      allowNull: false,
    },
    // credit adds to balance, debit removes from it.
    direction: {
      type: DataTypes.ENUM("credit", "debit"),
      allowNull: false,
    },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    title: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    // Optional link to the delivery order this txn came from.
    ref_order_id: { type: DataTypes.INTEGER, allowNull: true },
    // settled | pending
    status: {
      type: DataTypes.ENUM("settled", "pending"),
      allowNull: false,
      defaultValue: "settled",
    },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_delivery_wallet_txns",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "txn_id" }] },
      { name: "dwt_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
    ],
  }
);

module.exports = DeliveryWalletTxn;
