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