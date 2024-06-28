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
  timestamps: true,
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
