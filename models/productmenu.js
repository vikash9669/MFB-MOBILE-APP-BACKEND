const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

const ProductMenu = sequelize.define(
  "productmenu",
  {
    product_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true
    },
    product_menu_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true
    }
  }, {
  sequelize,
  tableName: 'store_products_menu',
  timestamps: false,
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "product_id" },
        { name: "product_menu_id" },
      ]
    },
  ]
});


module.exports = ProductMenu;