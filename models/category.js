const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// Product categories, as used by the admin panel's Categories module.
const Category = sequelize.define(
  "category",
  {
    cat_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    cat_name: { type: DataTypes.STRING(255), allowNull: true },
    cat_image: { type: DataTypes.STRING(255), allowNull: true },
    cat_status: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
  },
  {
    tableName: "store_categories",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "cat_id" }] },
    ],
  }
);

module.exports = Category;
