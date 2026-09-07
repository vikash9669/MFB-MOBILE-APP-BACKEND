const test = require("node:test");
const assert = require("node:assert");

const { PromoCampaign, PromoRedemption } = require("../models");
const { listAvailableCoupons, getCouponCodeDetails } = require("../util/coupon");

// The offers panel on the checkout screen.
//
// The property that matters most is not which coupons appear — it is that
// anything shown as applicable ACTUALLY APPLIES. A customer taps a code the app
// itself suggested; being told "invalid" at that point reads as a broken app,
// and is worse than never having offered it. Listing and applying therefore run
// through the same evaluateCampaign, and the last test here holds them together.

const withCampaigns = async (rows, fn) => {
  const realAll = PromoCampaign.findAll;
  const realOne = PromoCampaign.findOne;
  PromoCampaign.findAll = async () => rows;
  PromoCampaign.findOne = async ({ where }) =>
    rows.find((r) => r.promo_code === where.promo_code) ?? null;
  try {
    await fn();
  } finally {
    PromoCampaign.findAll = realAll;
    PromoCampaign.findOne = realOne;
  }
};

const withRedemptions = async (countFor, fn) => {
  const real = PromoRedemption.count;
  PromoRedemption.count = async ({ where }) => countFor(where.campaign_id) ?? 0;
  try {
    await fn();
  } finally {
    PromoRedemption.count = real;
  }
};

const campaign = (overrides = {}) => ({
  campaign_id: 1,
  title: "Test offer",
  body: "Some copy",
  status: "scheduled",
  expires_at: null,
  offer_type: "percent_off",
  offer_value: 20,
  min_order_amount: null,
  usage_limit_per_user: 1,
  promo_code: "SAVE20",
  targets: [],
  ...overrides,
});

const cart = { orderAmount: 500, businessUserId: 7, productIds: [1, 2], userId: 42 };

test("an applicable storewide coupon is listed with what it is worth", async () => {
  await withCampaigns([campaign()], async () => {
    await withRedemptions(() => 0, async () => {
      const [offer] = await listAvailableCoupons(cart);
      assert.strictEqual(offer.code, "SAVE20");
      assert.strictEqual(offer.applicable, true);
      assert.strictEqual(offer.discount, 100, "20% of 500");
      assert.strictEqual(offer.title, "Test offer");
      assert.match(offer.message, /saved/i);
    });
  });
});

test("a coupon for another restaurant is not shown at all", async () => {
  // Out of scope is not "shown greyed out" — it is nothing to do with this
  // cart, and listing it would be noise the customer has to read past.
  const other = campaign({ targets: [{ business_user_id: 999, product_id: null }] });
  await withCampaigns([other], async () => {
    await withRedemptions(() => 0, async () => {
      assert.deepStrictEqual(await listAvailableCoupons(cart), []);
    });
  });
});

test("a coupon for a dish in the cart is shown; one for a dish that is not, is not", async () => {
  const inCart = campaign({ campaign_id: 1, promo_code: "DISH1", targets: [{ product_id: 2 }] });
  const notInCart = campaign({ campaign_id: 2, promo_code: "DISH9", targets: [{ product_id: 9 }] });
  await withCampaigns([inCart, notInCart], async () => {
    await withRedemptions(() => 0, async () => {
      const codes = (await listAvailableCoupons(cart)).map((o) => o.code);
      assert.deepStrictEqual(codes, ["DISH1"]);
    });
  });
});

test("a coupon the customer has used up is hidden, not shown as unusable", async () => {
  // Advertising a code and then refusing it is the failure this panel exists to
  // avoid; a spent code is the clearest case of it.
  await withCampaigns([campaign({ usage_limit_per_user: 1 })], async () => {
    await withRedemptions(() => 1, async () => {
      assert.deepStrictEqual(await listAvailableCoupons(cart), []);
    });
  });
});

test("a near miss is shown with how much more is needed", async () => {
  // The useful half of "min order 600": how far away the customer is. This is
  // the row that grows a basket rather than just refusing it.
  await withCampaigns([campaign({ min_order_amount: 600 })], async () => {
    await withRedemptions(() => 0, async () => {
      const [offer] = await listAvailableCoupons({ ...cart, orderAmount: 480 });
      assert.strictEqual(offer.applicable, false);
      assert.strictEqual(offer.shortfall, 120);
      assert.strictEqual(offer.message, "Add ₹120 more to use this");
      assert.strictEqual(offer.min_order_amount, 600);
    });
  });
});

test("applicable offers come first, best saving first", async () => {
  const rows = [
    campaign({ campaign_id: 1, promo_code: "SMALL", offer_type: "flat_off", offer_value: 30 }),
    campaign({ campaign_id: 2, promo_code: "NEARLY", min_order_amount: 900 }),
    campaign({ campaign_id: 3, promo_code: "BIG", offer_type: "flat_off", offer_value: 120 }),
  ];
  await withCampaigns(rows, async () => {
    await withRedemptions(() => 0, async () => {
      const listed = await listAvailableCoupons(cart);
      assert.deepStrictEqual(listed.map((o) => o.code), ["BIG", "SMALL", "NEARLY"]);
      assert.strictEqual(listed[2].applicable, false);
    });
  });
});

test("free delivery is listed even though it has no discount figure", async () => {
  await withCampaigns([campaign({ offer_type: "free_delivery", offer_value: 0 })], async () => {
    await withRedemptions(() => 0, async () => {
      const [offer] = await listAvailableCoupons(cart);
      assert.strictEqual(offer.applicable, true);
      assert.strictEqual(offer.free_delivery, true);
      assert.strictEqual(offer.discount, 0);
    });
  });
});

test("a campaign with no code is skipped — there is nothing to apply", async () => {
  await withCampaigns([campaign({ promo_code: null })], async () => {
    await withRedemptions(() => 0, async () => {
      assert.deepStrictEqual(await listAvailableCoupons(cart), []);
    });
  });
});

// ── the contract that makes the panel safe ────────────────────────────────

test("every coupon listed as applicable really does apply", async () => {
  // Listing and applying are the same computation, and this is what keeps them
  // that way: if evaluateCampaign is ever bypassed on one side, this fails.
  const rows = [
    campaign({ campaign_id: 1, promo_code: "PCT", offer_type: "percent_off", offer_value: 15 }),
    campaign({ campaign_id: 2, promo_code: "FLAT", offer_type: "flat_off", offer_value: 75 }),
    campaign({ campaign_id: 3, promo_code: "SHIP", offer_type: "free_delivery", offer_value: 0 }),
    campaign({ campaign_id: 4, promo_code: "NEARLY", min_order_amount: 5000 }),
  ];
  await withCampaigns(rows, async () => {
    await withRedemptions(() => 0, async () => {
      const listed = await listAvailableCoupons(cart);
      assert.ok(listed.length >= 3, "fixture should produce several offers");

      for (const offer of listed) {
        const applied = await getCouponCodeDetails({
          code: offer.code,
          orderAmount: cart.orderAmount,
          businessUserId: cart.businessUserId,
          productIds: cart.productIds,
          userId: cart.userId,
        });
        assert.strictEqual(
          applied.success,
          offer.applicable,
          `${offer.code}: listed applicable=${offer.applicable} but applying gave success=${applied.success}`
        );
        if (offer.applicable) {
          assert.strictEqual(applied.discount, offer.discount, `${offer.code}: discount disagrees`);
          assert.strictEqual(applied.freeDelivery, offer.free_delivery, `${offer.code}: delivery disagrees`);
        }
      }
    });
  });
});
