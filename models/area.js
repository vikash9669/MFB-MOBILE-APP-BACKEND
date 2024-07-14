const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");
const Area = sequelize.define(
  "area",
  {
    area_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    area_pincode: {
      type: DataTypes.STRING(6),
      allowNull: false,
    },
    area_checkout: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 50,
    },
    area_charge: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 15,
    },
    area_charge_free: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 5000,
    },
    area_user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    area_status: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "store_users_area",
    timestamps: false,
    indexes: [
      {
        name: "area_id",
        unique: true,
        using: "BTREE",
        fields: [{ name: "area_id" }, { name: "area_user_id" }],
      },
      {
        name: "area_user_id",
        using: "BTREE",
        fields: [{ name: "area_user_id" }],
      },
    ],
  }
);

Area.removeAttribute('id');

module.exports = Area;

