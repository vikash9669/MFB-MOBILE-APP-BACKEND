const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");
const OrderLog = sequelize.define(
  "store_orders_log", {
  log_id: {
    autoIncrement: true,
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'store_orders',
      key: 'order_id'
    }
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'store_users',
      key: 'user_id'
    }
  },
  order_status: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  sequelize,
  tableName: 'store_orders_log',
  // The legacy table has one timestamp column, named updated_at, and no
  // created_at at all. Left at the default `timestamps: true`, Sequelize put
  // its own camelCase createdAt/updatedAt into every SELECT and the order
  // detail page died with ER_BAD_FIELD_ERROR.
  timestamps: true,
  createdAt: false,
  updatedAt: 'updated_at',
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "log_id" },
      ]
    },
    {
      name: "fk_log_order_id",
      using: "BTREE",
      fields: [
        { name: "order_id" },
      ]
    },
    {
      name: "fk_log_user_id",
      using: "BTREE",
      fields: [
        { name: "user_id" },
      ]
    },
  ]
});

module.exports = OrderLog;
