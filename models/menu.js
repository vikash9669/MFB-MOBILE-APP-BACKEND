const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

const Menu = sequelize.define(
  "menu", {
  menu_id: {
    autoIncrement: true,
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true
  },
  menu_type: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: 0,
    comment: "0=Cuisine, 1=Categories"
  },
  menu_type_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  menu_parent_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  menu_name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  menu_title: {
    type: DataTypes.STRING(70),
    allowNull: true
  },
  menu_keywords: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  menu_description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  menu_slug: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  menu_order: {
    type: DataTypes.SMALLINT,
    allowNull: true
  },
  menu_image: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  menu_user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  menu_status: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: 1
  }
}, {
  sequelize,
  tableName: 'store_menu',
  timestamps: false,
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "menu_id" },
      ]
    },
    {
      name: "menu_type",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "menu_type" },
        { name: "menu_parent_id" },
        { name: "menu_name" },
        { name: "menu_user_id" },
      ]
    },
  ]
});


module.exports = Menu;