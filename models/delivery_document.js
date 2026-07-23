const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// Partner KYC documents. Own delivery collection (store_delivery_documents).
const DeliveryDocument = sequelize.define(
  "delivery_document",
  {
    doc_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    // license | pan | aadhaar | rc | insurance
    doc_type: { type: DataTypes.STRING(30), allowNull: false },
    title: { type: DataTypes.STRING(80), allowNull: false },
    // active | expiring | pending | rejected
    status: {
      type: DataTypes.ENUM("active", "expiring", "pending", "rejected"),
      allowNull: false,
      defaultValue: "active",
    },
    expires_on: { type: DataTypes.DATEONLY, allowNull: true },
    file_url: { type: DataTypes.TEXT, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_delivery_documents",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "doc_id" }] },
      { name: "dd_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
    ],
  }
);

module.exports = DeliveryDocument;
