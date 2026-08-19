const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

const Address = sequelize.define(
  "store_users_shipping_address", {
  delivery_id: {
    autoIncrement: true,
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  delivery_address: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  delivery_landmark: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  delivery_phone: {
    type: DataTypes.STRING(13),
    allowNull: false
  },
  delivery_pin: {
    type: DataTypes.STRING(6),
    allowNull: false
  },
  delivery_city: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  delivery_state: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  delivery_status: {
    type: DataTypes.TINYINT,
    allowNull: false
  },
  // Added by migrations/2026-08-08-address-geo.sql. These may not exist on a
  // database where that has not been applied, so nothing queries them blindly:
  // util/addressColumns.js probes the table once and every read and write is
  // shaped to the columns that are actually present. See that file for why.
  //
  // Where the customer dropped the pin. Null for addresses typed before the
  // map picker existed, and for anyone who declines location and types instead.
  delivery_lat: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  delivery_lng: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  // Flat / house / floor — the part of an address no map can know.
  delivery_house: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  // "Home" | "Work" | "Other".
  delivery_label: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  // Google's formatted_address for the pin, kept as returned.
  delivery_formatted: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  delivery_place_id: {
    type: DataTypes.STRING(255),
    allowNull: true
  }
}, {
  sequelize,
  tableName: 'store_users_shipping_address',
  timestamps: false,
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "delivery_id" },
      ]
    },
    {
      name: "delivery_user_id",
      using: "BTREE",
      fields: [
        { name: "customer_id" },
      ]
    },
  ]
});


module.exports = Address;