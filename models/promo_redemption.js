const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// One row per order that actually redeemed a promo code — the source of truth
// for usage_limit_per_user (util/coupon.js counts these per campaign+user).
const PromoRedemption = sequelize.define(
  "promo_redemption",
  {
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    campaign_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    order_id: { type: DataTypes.INTEGER, allowNull: true },
    discount_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_promo_redemptions",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "id" }] },
      { name: "promo_redemption_usage_idx", fields: [{ name: "campaign_id" }, { name: "user_id" }] },
      { name: "promo_redemption_order_idx", fields: [{ name: "order_id" }] },
    ],
  }
);

module.exports = PromoRedemption;
