const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");
const Banner = sequelize.define(
  "banner",
  {
    banner_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    banner_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    banner_href: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    banner_path: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    banner_position: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
    banner_status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    banner_title: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "store_banners",
    timestamps: false,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "banner_id" }],
      },
    ],
  }
);

module.exports = Banner;
