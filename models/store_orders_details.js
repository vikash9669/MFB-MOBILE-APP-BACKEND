const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

const OrderDetails = sequelize.define(
  "store_orders_details",
  {
    order_detail_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true
    },
    order_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    product_id: {
      // Must match store_products.product_id (INTEGER) for the FK to build.
      type: DataTypes.INTEGER,
      allowNull: false
    },
    product_qty: {
      type: DataTypes.TINYINT,
      allowNull: false
    },
    product_mrp: {
      type: DataTypes.SMALLINT,
      allowNull: false
    },
    product_price: {
      type: DataTypes.SMALLINT,
      allowNull: false
    },
    product_discount: {
      type: DataTypes.SMALLINT,
      allowNull: false
    },
    product_total: {
      type: DataTypes.SMALLINT,
      allowNull: false
    },
    product_available: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1
    }
  }, {
  sequelize,
  tableName: 'store_orders_details',
  timestamps: false,
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "order_detail_id" },
      ]
    },
    {
      name: "order_id",
      using: "BTREE",
      fields: [
        { name: "order_id" },
      ]
    },
  ]
});
module.exports = OrderDetails;