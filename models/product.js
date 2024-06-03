const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

const Product = sequelize.define(
  "product",
  {
    product_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    product_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    product_mrp: {
      type: DataTypes.SMALLINT,
      allowNull: false,
    },
    product_minimum: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
    product_price: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    product_image: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    product_title: {
      type: DataTypes.STRING(70),
      allowNull: true,
    },
    product_keywords: {
      type: DataTypes.STRING(190),
      allowNull: true,
    },
    product_description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    product_user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    product_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    product_status: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: "store_products",
    timestamps: false,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "product_id" }],
      },
    ],
  }
);

module.exports = Product;
