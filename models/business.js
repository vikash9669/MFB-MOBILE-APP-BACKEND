const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");
const Business = sequelize.define(
  "business", {
  business_id: {
    autoIncrement: true,
    type: DataTypes.INTEGER,
    allowNull: false,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'store_users',
      key: 'user_id'
    }
  },
  business_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  business_order: {
    type: DataTypes.SMALLINT,
    allowNull: false
  },
  business_slug: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  business_menu_types: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  business_type: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0
  },
  business_gstin: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  business_personal_pan: {
    type: DataTypes.STRING(11),
    allowNull: true
  },
  business_company_pan: {
    type: DataTypes.STRING(11),
    allowNull: true
  },
  business_tan: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  business_cin: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  business_fssai: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  business_open: {
    type: DataTypes.TIME,
    allowNull: true
  },
  business_close: {
    type: DataTypes.TIME,
    allowNull: true
  },
  business_status: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: 0
  },
  business_discount: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0
  },
  business_offer_text: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  business_commision: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 15
  }
}, {
  sequelize,
  tableName: 'store_users_business',
  timestamps: false,
  indexes: [
    {
      name: "PRIMARY",
      unique: true,
      using: "BTREE",
      fields: [
        { name: "business_id" },
      ]
    },
    {
      name: "fk_name",
      using: "BTREE",
      fields: [
        { name: "user_id" },
      ]
    },
  ]
});

module.exports = Business;