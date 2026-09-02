const test = require("node:test");
const assert = require("node:assert");

const { PromoCampaign, PromoRedemption } = require("../models");
const { getCouponCodeDetails } = require("../util/coupon");

// Monkey-patches the real model's static methods for the duration of `fn`,
// same pattern test/orderAcceptSweeper.test.js already uses — no real
// database is ever touched, and the original is always restored.
const withCampaign = async (campaign, fn) => {
  const real = PromoCampaign.findOne;
  PromoCampaign.findOne = async () => campaign;
  try {
    await fn();
  } finally {
    PromoCampaign.findOne = real;
  }
};

const withRedemptionCount = async (count, fn) => {
  const real = PromoRedemption.count;
  PromoRedemption.count = async () => count;
  try {
    await fn();
  } finally {
    PromoRedemption.count = real;
  }
};

const baseCampaign = (overrides = {}) => ({
  campaign_id: 1,
  status: "scheduled",
  expires_at: null,
  offer_type: "percent_off",
  offer_value: 20,
  min_order_amount: null,
  usage_limit_per_user: 1,
  promo_code: "PROMO-TEST",
  targets: [],
  ...overrides,
});

test("no campaign matches the code: falls through to the legacy FLASH50 coupon, unchanged", async () => {
  await withCampaign(null, async () => {
    const result = await getCouponCodeDetails({ code: "FLASH50", orderAmount: 200, platform: "ios" });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.discount, 100);
    assert.strictEqual(result.campaignId, undefined);
  });
});

test("no campaign, FLASH50 on the wrong platform: invalid, exactly as today", async () => {
  await withCampaign(null, async () => {
    const result = await getCouponCodeDetails({ code: "FLASH50", orderAmount: 200, platform: "android" });
    assert.strictEqual(result.valid, false);
  });
});

test("a storewide campaign (no targets) applies to any vendor", async () => {
  await withCampaign(baseCampaign(), async () => {
    await withRedemptionCount(0, async () => {
      const result = await getCouponCodeDetails({
        code: "PROMO-TEST",
        orderAmount: 200,
        businessUserId: 999,
        productIds: [],
        userId: 5,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.discount, 40); // 20% of 200
      assert.strictEqual(result.campaignId, 1);
    });
  });
});

test("a vendor-scoped campaign rejects a cart from a different vendor", async () => {
  const campaign = baseCampaign({ targets: [{ business_user_id: 42, product_id: null }] });
  await withCampaign(campaign, async () => {
    const result = await getCouponCodeDetails({
      code: "PROMO-TEST",
      orderAmount: 200,
      businessUserId: 99,
      productIds: [],
    });
    assert.strictEqual(result.valid, false);
  });
});

test("a vendor-scoped campaign accepts any item from the right vendor", async () => {
  const campaign = baseCampaign({ targets: [{ business_user_id: 42, product_id: null }] });
  await withCampaign(campaign, async () => {
    await withRedemptionCount(0, async () => {
      const result = await getCouponCodeDetails({
        code: "PROMO-TEST",
        orderAmount: 200,
        businessUserId: 42,
        productIds: [7],
      });
      assert.strictEqual(result.success, true);
    });
  });
});

test("a product-scoped campaign requires that exact product in the cart", async () => {
  const campaign = baseCampaign({ targets: [{ business_user_id: 42, product_id: 555 }] });
  await withCampaign(campaign, async () => {
    const missing = await getCouponCodeDetails({
      code: "PROMO-TEST",
      orderAmount: 200,
      businessUserId: 42,
      productIds: [1, 2],
    });
    assert.strictEqual(missing.valid, false);

    await withRedemptionCount(0, async () => {
      const hit = await getCouponCodeDetails({
        code: "PROMO-TEST",
        orderAmount: 200,
        businessUserId: 42,
        productIds: [555],
      });
      assert.strictEqual(hit.success, true);
    });
  });
});

test("usage limit blocks a user who already redeemed it", async () => {
  await withCampaign(baseCampaign({ usage_limit_per_user: 1 }), async () => {
    await withRedemptionCount(1, async () => {
      const blocked = await getCouponCodeDetails({ code: "PROMO-TEST", orderAmount: 200, userId: 5 });
      assert.strictEqual(blocked.valid, true);
      assert.strictEqual(blocked.success, false);
    });
  });
});

test("usage limit is skipped (not guessed) when no userId is known — the public preview path", async () => {
  await withCampaign(baseCampaign({ usage_limit_per_user: 1 }), async () => {
    await withRedemptionCount(1, async () => {
      const preview = await getCouponCodeDetails({ code: "PROMO-TEST", orderAmount: 200 });
      assert.strictEqual(preview.success, true);
    });
  });
});

test("min_order_amount blocks a cart under the threshold", async () => {
  await withCampaign(baseCampaign({ min_order_amount: 300 }), async () => {
    await withRedemptionCount(0, async () => {
      const result = await getCouponCodeDetails({ code: "PROMO-TEST", orderAmount: 100, userId: 5 });
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.success, false);
    });
  });
});

test("free_delivery sets freeDelivery with zero line-item discount", async () => {
  await withCampaign(baseCampaign({ offer_type: "free_delivery", offer_value: null }), async () => {
    await withRedemptionCount(0, async () => {
      const result = await getCouponCodeDetails({ code: "PROMO-TEST", orderAmount: 200, userId: 5 });
      assert.strictEqual(result.freeDelivery, true);
      assert.strictEqual(result.discount, 0);
      assert.strictEqual(result.success, true);
    });
  });
});

test("flat_off never discounts more than the order amount", async () => {
  await withCampaign(baseCampaign({ offer_type: "flat_off", offer_value: 500 }), async () => {
    await withRedemptionCount(0, async () => {
      const result = await getCouponCodeDetails({ code: "PROMO-TEST", orderAmount: 100, userId: 5 });
      assert.strictEqual(result.discount, 100);
    });
  });
});
