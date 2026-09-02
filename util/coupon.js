const { Op } = require("sequelize");
const { PromoCampaign, PromoTarget, PromoRedemption } = require("../models");

const MIN_ORDER_AMOUNT = 100;

// A campaign's code is redeemable once it has left draft (been scheduled/sent)
// and hasn't been cancelled — matches util/promoNotificationSweeper.js's own
// state machine. Expiry is checked separately from send status: a campaign can
// still be redeemable well after it was sent.
const ACTIVE_STATUSES = ["scheduled", "sending", "sent"];

const lookupPromoCampaign = async (code) => {
  if (!code) return null;
  return PromoCampaign.findOne({
    where: {
      promo_code: code,
      status: { [Op.in]: ACTIVE_STATUSES },
      [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: new Date() } }],
    },
    include: [{ model: PromoTarget, as: "targets" }],
  });
};

// No target rows = storewide. A vendor-only row matches any product from that
// vendor; a product row requires that exact dish in the cart.
const scopeMatches = (campaign, { businessUserId, productIds }) => {
  const targets = campaign.targets || [];
  if (targets.length === 0) return true;

  const ids = (productIds || []).map(Number);
  return targets.some((t) => {
    if (t.product_id != null) return ids.includes(Number(t.product_id));
    if (t.business_user_id != null) {
      return businessUserId != null && Number(t.business_user_id) === Number(businessUserId);
    }
    return false;
  });
};

// Only enforceable when the caller is known — see the userId note in
// util/orders.js::priceCart. Without an identity (the unauthenticated /coupon
// preview) this can't be checked and is skipped rather than guessed.
const usageRemaining = async (campaign, userId) => {
  if (userId == null) return true;
  const used = await PromoRedemption.count({
    where: { campaign_id: campaign.campaign_id, user_id: userId },
  });
  return used < Number(campaign.usage_limit_per_user);
};

const computeDiscount = (campaign, orderAmount) => {
  switch (campaign.offer_type) {
    case "percent_off":
      return {
        discount: Math.floor(orderAmount * (Number(campaign.offer_value) / 100)),
        freeDelivery: false,
      };
    case "flat_off":
      return { discount: Math.min(Number(campaign.offer_value), orderAmount), freeDelivery: false };
    case "free_delivery":
      return { discount: 0, freeDelivery: true };
    default:
      return { discount: 0, freeDelivery: false };
  }
};

/**
 * Resolves a coupon/promo code into a discount. Checks the admin-managed
 * promo_campaigns table first; falls through to the legacy hardcoded FLASH50
 * coupon unchanged if no campaign matches, so the old code keeps working
 * exactly as it always has.
 *
 * `businessUserId`/`productIds` scope-check a campaign's targets; `userId`
 * enforces its per-user usage limit. Both are optional — see the callers in
 * controllers/order.js (public preview, neither available) and
 * util/orders.js::priceCart (authenticated order creation, both available).
 */
const getCouponCodeDetails = async ({ code, orderAmount, platform, businessUserId, productIds, userId }) => {
  const campaign = await lookupPromoCampaign(code);

  if (campaign != null) {
    if (!scopeMatches(campaign, { businessUserId, productIds })) {
      return {
        valid: false,
        success: false,
        discount: 0,
        message: "This code isn't valid for the items in your cart",
        freeDelivery: false,
      };
    }

    if (!(await usageRemaining(campaign, userId))) {
      return {
        valid: true,
        success: false,
        discount: 0,
        message: "You've already used this code",
        freeDelivery: false,
      };
    }

    const minOrder = campaign.min_order_amount != null ? Number(campaign.min_order_amount) : 0;
    if (orderAmount < minOrder) {
      return {
        valid: true,
        success: false,
        discount: 0,
        message: `Min. order value should be ${minOrder}!`,
        freeDelivery: false,
      };
    }

    const { discount, freeDelivery } = computeDiscount(campaign, orderAmount);
    return {
      valid: true,
      success: true,
      discount,
      message: freeDelivery ? "Free delivery on this order!" : `Congratulations! You saved ₹${discount}!`,
      freeDelivery,
      campaignId: campaign.campaign_id,
    };
  }

  if (code?.toLowerCase() === "flash50" && platform === "ios") {
    if (orderAmount >= MIN_ORDER_AMOUNT) {
      return {
        valid: true,
        success: true,
        discount: Math.floor(orderAmount / 2),
        message: "Congratulations! You've got flat 50% off!",
        freeDelivery: false,
      };
    }
    return {
      valid: true,
      success: false,
      discount: 0,
      message: `Min. order value should be ${MIN_ORDER_AMOUNT}!`,
      freeDelivery: false,
    };
  }

  return {
    valid: false,
    success: false,
    discount: 0,
    message: "Invalid coupon code!",
    freeDelivery: false,
  };
};

module.exports = {
  getCouponCodeDetails,
};
