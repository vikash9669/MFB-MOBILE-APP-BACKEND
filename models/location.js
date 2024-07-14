const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");
const Location = sequelize.define(
  "location",
  {
    location_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    location_parent_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    location_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    location_pincode: {
      type: DataTypes.STRING(6),
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "store_locations",
    timestamps: false,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "location_id" }],
      },
      {
        name: "location_id_fk",
        using: "BTREE",
        fields: [{ name: "location_id" }],
      },
      {
        name: "state_id",
        using: "BTREE",
        fields: [{ name: "location_parent_id" }],
      },
    ],
  }
);

module.exports = Location;
