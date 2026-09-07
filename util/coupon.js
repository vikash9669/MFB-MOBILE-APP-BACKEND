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
/**
 * Decides what ONE campaign is worth to this cart, right now.
 *
 * Extracted so that listing a coupon and applying it are the same computation
 * rather than two that agree today. A checkout screen that offers a code the
 * apply step then rejects is worse than not offering it at all — the customer
 * taps something we suggested and is told it does not work.
 *
 * `shortfall` is set only for a min-order miss, so a caller can say "add ₹120
 * more" instead of "not valid" and the customer knows what to do about it.
 */
const evaluateCampaign = async (campaign, { orderAmount, businessUserId, productIds, userId }) => {
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
      exhausted: true,
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
      shortfall: Math.ceil(minOrder - orderAmount),
      minOrderAmount: minOrder,
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
    minOrderAmount: minOrder,
  };
};

const getCouponCodeDetails = async ({ code, orderAmount, platform, businessUserId, productIds, userId }) => {
  const campaign = await lookupPromoCampaign(code);

  if (campaign != null) {
    return evaluateCampaign(campaign, { orderAmount, businessUserId, productIds, userId });
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

// A cart cannot realistically be shown more than a handful of offers, and an
// unbounded scan of every campaign ever created is a slow query on a screen the
// customer is waiting on.
const MAX_LISTED = Number(process.env.COUPON_LIST_MAX || 20);

/**
 * The coupons worth showing on this cart's checkout screen.
 *
 * Returns applicable ones first, best discount first, then the ones the
 * customer is close to earning. Codes they have already used up are left out
 * entirely: showing a coupon that cannot be applied is noise, and worse, it
 * reads as the app being broken.
 *
 * Every entry is evaluated by evaluateCampaign — the same function the apply
 * step uses — so anything listed as applicable will apply.
 */
const listAvailableCoupons = async ({ orderAmount, businessUserId, productIds, userId }) => {
  const campaigns = await PromoCampaign.findAll({
    where: {
      status: { [Op.in]: ACTIVE_STATUSES },
      promo_code: { [Op.ne]: null },
      [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: new Date() } }],
    },
    include: [{ model: PromoTarget, as: "targets" }],
    order: [["campaign_id", "DESC"]],
    limit: 200,
  });

  const evaluated = [];
  for (const campaign of campaigns) {
    if (!campaign.promo_code) continue;
    const result = await evaluateCampaign(campaign, {
      orderAmount,
      businessUserId,
      productIds,
      userId,
    });

    // Out of scope for this cart, or already used up: not an offer, so not
    // shown. `valid: false` is the scope miss; `exhausted` is the usage limit.
    if (!result.valid || result.exhausted) continue;

    evaluated.push({
      code: campaign.promo_code,
      title: campaign.title,
      // The campaign body doubles as the offer's own description — it is what
      // the customer was shown in the push that advertised it, so the wording
      // they recognise.
      description: campaign.body || null,
      offer_type: campaign.offer_type,
      offer_value: Number(campaign.offer_value),
      min_order_amount: result.minOrderAmount ?? 0,
      expires_at: campaign.expires_at,
      applicable: result.success === true,
      discount: result.discount,
      free_delivery: result.freeDelivery === true,
      // What the row says under the code. For a near miss this is the useful
      // half of the message — how much more is needed.
      message: result.success
        ? result.message
        : result.shortfall != null
          ? `Add ₹${result.shortfall} more to use this`
          : result.message,
      shortfall: result.shortfall ?? null,
    });
  }

  return evaluated
    .sort((a, b) => {
      if (a.applicable !== b.applicable) return a.applicable ? -1 : 1;
      // Among applicable ones, the biggest saving first — free delivery has no
      // discount figure, so it sorts after a real reduction unless nothing else
      // applies. Among near misses, the closest first.
      if (a.applicable) return b.discount - a.discount || Number(b.free_delivery) - Number(a.free_delivery);
      return (a.shortfall ?? Infinity) - (b.shortfall ?? Infinity);
    })
    .slice(0, MAX_LISTED);
};

module.exports = {
  getCouponCodeDetails,
  listAvailableCoupons,
};
