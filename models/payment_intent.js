const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// Holds a checkout while the customer is away in the payment gateway's app
// or hosted page. The store_orders row is only written once the gateway
// confirms the payment, which is
// how the legacy PHP storefront behaved — restaurants never see an unpaid
// order. An abandoned payment just leaves a stale intent here.
const PaymentIntent = sequelize.define(
  "store_payment_intents",
  {
    pi_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    // What we hand the gateway as its merchant order/transaction id. Also
    // what comes back
    // on the callback, so it is the lookup key for the whole flow.
    merchant_txn_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    customer_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    vendor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    address_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Rupees, matching store_orders.order_amount. Never paise — see the note in
    // util/payments.js about the SMALLINT overflow in the legacy data.
    amount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // The cart + resolved pricing, so the order can be built after payment
    // without trusting anything the client sends back.
    cart_snapshot: {
      type: DataTypes.TEXT("long"),
      allowNull: false,
    },
    // UPI | CARD — what the customer picked in the app. The gateway reports
    // the instrument actually used; this is only the requested preference.
    method: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "UPI",
    },
    // PENDING → PAID | FAILED. Terminal states are never re-processed, which
    // is what keeps the callback and the client confirm from double-creating
    // an order.
    status: {
      type: DataTypes.ENUM("PENDING", "PAID", "FAILED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    // Set once PhonePe returns a transaction id.
    provider_txn_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // The store_orders row created after a successful payment.
    order_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    failure_reason: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "store_payment_intents",
    timestamps: true,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "pi_id" }] },
      { name: "merchant_txn_id", unique: true, using: "BTREE", fields: [{ name: "merchant_txn_id" }] },
      { name: "pi_customer_id", using: "BTREE", fields: [{ name: "customer_id" }] },
    ],
  }
);

module.exports = PaymentIntent;
