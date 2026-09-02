const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// Which vendors/products a promo campaign is scoped to. A row with only
// business_user_id set means "any item from this vendor qualifies"; a row with
// product_id set scopes to that exact dish. No rows at all = storewide/unscoped
// — see util/coupon.js's scope check.
const PromoTarget = sequelize.define(
  "promo_target",
  {
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    campaign_id: { type: DataTypes.INTEGER, allowNull: false },
    business_user_id: { type: DataTypes.INTEGER, allowNull: true },
    product_id: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "store_promo_targets",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "id" }] },
      { name: "promo_target_campaign_idx", fields: [{ name: "campaign_id" }] },
      { name: "promo_target_vendor_idx", fields: [{ name: "business_user_id" }] },
      { name: "promo_target_product_idx", fields: [{ name: "product_id" }] },
    ],
  }
);

module.exports = PromoTarget;
