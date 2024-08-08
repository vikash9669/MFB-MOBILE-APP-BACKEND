const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

const StoreOrders = sequelize.define(
  "store_orders",
  {
    order_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
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
    rider_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    vendor_discount: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    order_amount: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    order_discount: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    delivery_charges: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    order_amount_paid: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    order_profit: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    order_payment_type: {
      type: DataTypes.ENUM("COD", "PG"),
      allowNull: false,
      defaultValue: "COD",
    },
    order_transaction_id: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "COD",
    },
    order_payment_status: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 0,
    },
    order_payment_received: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    order_received_time: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: sequelize.literal("CURRENT_TIMESTAMP"),
    },
    order_delivered_time: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    order_status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
      comment:
        "0 = Recieved, 1 = Processed, 2 = Vendor, 3 = Ready to Ship Delivered, 4 = On the Way, 5= Delivered, 6 = Cancelled",
    },
    order_updated_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    sequelize,
    tableName: "store_orders",
    timestamps: false,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "order_id" }],
      },
      {
        name: "order_user_id",
        using: "BTREE",
        fields: [{ name: "customer_id" }],
      },
      {
        name: "order_vendor_id",
        using: "BTREE",
        fields: [{ name: "vendor_id" }],
      },
      {
        name: "address_id_orders_fk",
        using: "BTREE",
        fields: [{ name: "address_id" }],
      },
      {
        name: "delivery_boy_id_orders_fk",
        using: "BTREE",
        fields: [{ name: "rider_id" }],
      },
    ],
  }
);

module.exports = StoreOrders;
