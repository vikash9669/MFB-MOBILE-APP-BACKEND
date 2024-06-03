const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

const User = sequelize.define(
  "user",
  {
    user_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    user_role: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    user_name: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    user_email: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    user_phone: {
      type: DataTypes.STRING(12),
      allowNull: true,
    },
    user_otp: {
      type: DataTypes.STRING(6),
      allowNull: false,
    },
    user_code: {
      type: DataTypes.STRING(12),
      allowNull: false,
    },
    user_cashback: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    user_earnings: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    user_manager: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    user_phone_1: {
      type: DataTypes.STRING(12),
      allowNull: false,
    },
    user_address: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    user_landmark: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    user_city: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    user_state: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    user_zip: {
      type: DataTypes.STRING(6),
      allowNull: false,
    },
    user_image: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    user_password: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    user_registered: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: NOW,
    },
    user_login: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 2,
    },
    user_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 2,
    },
    user_status: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: 1,
    },
    user_session: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    user_last_login: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "store_users",
    timestamps: false,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [{ name: "user_id" }],
      },
    ],
  }
);

module.exports = User;