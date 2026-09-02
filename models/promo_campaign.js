const { DataTypes, NOW } = require("sequelize");
const sequelize = require("../util/database");

// An admin-composed promotional push, optionally carrying a checkout discount.
// See util/promoNotificationSweeper.js (sends it) and util/coupon.js (redeems
// its promo_code at checkout).
const PromoCampaign = sequelize.define(
  "promo_campaign",
  {
    campaign_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    title: { type: DataTypes.STRING(160), allowNull: false },
    body: { type: DataTypes.STRING(255), allowNull: true },
    // Uploaded filename only (kind "promos") — same convention as
    // store_banners.banner_path, resolved client-side via ASSETS_BASE_URL.
    image: { type: DataTypes.STRING(255), allowNull: true },
    offer_type: {
      type: DataTypes.ENUM("none", "percent_off", "flat_off", "free_delivery"),
      allowNull: false,
      defaultValue: "none",
    },
    offer_value: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    min_order_amount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    promo_code: { type: DataTypes.STRING(24), allowNull: true },
    usage_limit_per_user: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    scheduled_at: { type: DataTypes.DATE, allowNull: false },
    sent_at: { type: DataTypes.DATE, allowNull: true },
    status: {
      type: DataTypes.ENUM("draft", "scheduled", "sending", "sent", "cancelled", "failed"),
      allowNull: false,
      defaultValue: "draft",
    },
    target_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sent_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    failed_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: NOW },
  },
  {
    tableName: "store_promo_campaigns",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "campaign_id" }] },
      { name: "promo_code_uniq", unique: true, fields: [{ name: "promo_code" }] },
      { name: "promo_due_idx", fields: [{ name: "status" }, { name: "scheduled_at" }] },
    ],
  }
);

module.exports = PromoCampaign;
