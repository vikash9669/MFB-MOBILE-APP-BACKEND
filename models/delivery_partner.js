const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Delivery-partner accounts live in their own table (created automatically by
// sequelize.sync) so partner data stays separate from customers in store_users.
const DeliveryPartner = sequelize.define(
  "delivery_partner",
  {
    dp_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_name: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: "",
    },
    dp_email: {
      type: DataTypes.STRING(120),
      allowNull: false,
      defaultValue: "",
    },
    dp_phone: {
      type: DataTypes.STRING(12),
      allowNull: false,
    },
    dp_code: {
      type: DataTypes.STRING(12),
      allowNull: false,
    },
    // Holds the latest OTPless requestId between get-otp and verify-otp.
    dp_request_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    // Bumped on logout to invalidate all outstanding refresh tokens.
    dp_token_version: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    // Server-synced app settings / permission flags (JSON blob).
    dp_settings: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    // ── Profile / vehicle ────────────────────────────────────────────
    dp_vehicle_type: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "Bike",
    },
    dp_vehicle_number: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    // ── Live status ──────────────────────────────────────────────────
    // Whether the partner is currently online and accepting orders.
    dp_online: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 0,
    },
    dp_lat: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    },
    dp_lng: {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    },
    // ── Money ────────────────────────────────────────────────────────
    // Withdrawable wallet balance (kept as a running total in rupees).
    dp_wallet_balance: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // COD cash the partner is holding and still owes the company.
    dp_cash_in_hand: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // ── Performance metrics ──────────────────────────────────────────
    dp_rating: {
      type: DataTypes.DECIMAL(3, 2),
      allowNull: false,
      defaultValue: 5.0,
    },
    dp_total_deliveries: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    dp_on_time_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    dp_acceptance_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    dp_completion_pct: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    dp_cancellation_pct: {
      type: DataTypes.DECIMAL(4, 1),
      allowNull: false,
      defaultValue: 0,
    },
    dp_avg_delivery_min: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    dp_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 1,
    },
    dp_registered: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: NOW,
    },
    dp_last_login: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "store_delivery_partners",
    timestamps: false,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "dp_id" }],
      },
    ],
  }
);

module.exports = DeliveryPartner;
