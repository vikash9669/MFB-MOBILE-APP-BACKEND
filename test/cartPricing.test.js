const test = require("node:test");
const assert = require("node:assert");

const { Product, Business, Address, Area, PromoCampaign, PromoRedemption } = require("../models");
const { priceCart } = require("../util/orders");

// What the customer is actually charged.
//
// test/couponListing.test.js proves which coupons are OFFERED and
// test/promoCoupon.test.js proves what one is WORTH. Neither charges anybody.
// These tests cover the step after: that the figure lands in the store_orders
// columns the rest of the system settles against.
//
// The invariant every consumer of those columns depends on:
//
//     payable = order_amount + delivery_charges - order_discount
//
// used by the app's My Orders and tracking screens, the rider's cash-to-collect
// in util/deliveryDispatch.js, and the panel in controllers/admin/orders.js.
// order_amount must therefore be GROSS — goods before any discount. It was once
// written net of the vendor discount while order_discount also reported it,
// which deducted the same discount twice.

const stub = async (overrides, fn) => {
  const real = {
    productFindAll: Product.findAll,
    addressFindByPk: Address.findByPk,
    businessFindOne: Business.findOne,
    areaFindOne: Area.findOne,
    campaignFindOne: PromoCampaign.findOne,
    redemptionCount: PromoRedemption.count,
  };

  Product.findAll = async () => overrides.products;
  Address.findByPk = async () => ({ delivery_city: 1 });
  Business.findOne = async () => ({
    business_discount: overrides.businessDiscount ?? 0,
    business_rain_charges: overrides.rainCharges ?? 0,
  });
  Area.findOne = async () => ({
    area_charge: overrides.areaCharge ?? 15,
    area_charge_free: overrides.areaChargeFree ?? 500,
  });
  PromoCampaign.findOne = async () => overrides.campaign ?? null;
  PromoRedemption.count = async () => overrides.redemptions ?? 0;

  try {
    return await fn();
  } finally {
    Product.findAll = real.productFindAll;
    Address.findByPk = real.addressFindByPk;
    Business.findOne = real.businessFindOne;
    Area.findOne = real.areaFindOne;
    PromoCampaign.findOne = real.campaignFindOne;
    PromoRedemption.count = real.redemptionCount;
  }
};

// A ₹150 cart: three items at 40/50/60.
const CART = { 1: 1, 2: 1, 3: 1 };
const PRODUCTS = [
  { product_id: 1, product_mrp: 40 },
  { product_id: 2, product_mrp: 50 },
  { product_id: 3, product_mrp: 60 },
];

const campaign = (overrides = {}) => ({
  campaign_id: 7,
  status: "sent",
  expires_at: null,
  offer_type: "flat_off",
  offer_value: 30,
  min_order_amount: null,
  usage_limit_per_user: 1,
  promo_code: "SAVE",
  targets: [],
  ...overrides,
});

const price = (overrides = {}) =>
  stub({ products: PRODUCTS, ...overrides }, () =>
    priceCart({
      address_id: 1,
      product_ids_with_quantity: CART,
      business_user_id: 5,
      coupon_code: overrides.code ?? null,
      user_id: 42,
    })
  );

const payableOf = (p) => p.order_amount + p.delivery_charges - p.order_discount;

test("no coupon: goods plus delivery, nothing taken off", async () => {
  const p = await price();
  assert.strictEqual(p.order_amount, 150);
  assert.strictEqual(p.order_discount, 0);
  assert.strictEqual(p.delivery_charges, 15);
  assert.strictEqual(p.payable, 165);
  assert.strictEqual(payableOf(p), p.payable, "columns must reconstruct the payable");
});

test("a flat coupon comes off the total", async () => {
  const p = await price({ code: "SAVE", campaign: campaign() });
  assert.strictEqual(p.order_discount, 30);
  assert.strictEqual(p.delivery_charges, 15, "a discount does not touch delivery");
  assert.strictEqual(p.payable, 135);
  assert.strictEqual(payableOf(p), p.payable);
});

test("a percentage coupon comes off the total", async () => {
  const p = await price({ code: "SAVE", campaign: campaign({ offer_type: "percent_off", offer_value: 20 }) });
  assert.strictEqual(p.order_discount, 30, "20% of 150");
  assert.strictEqual(p.payable, 135);
});

test("a free-delivery coupon zeroes the delivery charge, not the goods", async () => {
  const p = await price({ code: "SAVE", campaign: campaign({ offer_type: "free_delivery", offer_value: 0 }) });
  assert.strictEqual(p.delivery_charges, 0, "this is the whole point of the offer");
  assert.strictEqual(p.order_discount, 0, "free delivery is not a discount on the food");
  assert.strictEqual(p.order_amount, 150);
  assert.strictEqual(p.payable, 150);
  assert.strictEqual(payableOf(p), p.payable);
});

test("a coupon for another restaurant takes nothing off", async () => {
  const p = await price({
    code: "SAVE",
    campaign: campaign({ targets: [{ business_user_id: 999, product_id: null }] }),
  });
  assert.strictEqual(p.order_discount, 0);
  assert.strictEqual(p.payable, 165);
});

test("a dish coupon applies only when that dish is in the cart", async () => {
  const inCart = await price({ code: "SAVE", campaign: campaign({ targets: [{ product_id: 3 }] }) });
  assert.strictEqual(inCart.order_discount, 30);

  const notInCart = await price({ code: "SAVE", campaign: campaign({ targets: [{ product_id: 99 }] }) });
  assert.strictEqual(notInCart.order_discount, 0, "the dish it was made for is not being bought");
});

test("a coupon below its minimum order value takes nothing off", async () => {
  const p = await price({ code: "SAVE", campaign: campaign({ min_order_amount: 300 }) });
  assert.strictEqual(p.order_discount, 0);
  assert.strictEqual(p.payable, 165);
});

test("a coupon the customer has already used takes nothing off", async () => {
  const p = await price({ code: "SAVE", campaign: campaign(), redemptions: 1 });
  assert.strictEqual(p.order_discount, 0);
  assert.strictEqual(p.campaignId, null, "and no second redemption is recorded");
});

test("delivery is free above the area's threshold without any coupon", async () => {
  const p = await stub({ products: [{ product_id: 1, product_mrp: 600 }] }, () =>
    priceCart({
      address_id: 1,
      product_ids_with_quantity: { 1: 1 },
      business_user_id: 5,
      user_id: 42,
    })
  );
  assert.strictEqual(p.delivery_charges, 0);
  assert.strictEqual(p.payable, 600);
});

// ── the invariant that was broken ──────────────────────────────────────────

test("a vendor discount is deducted once, not twice", async () => {
  // The regression: order_amount was stored net of the vendor discount while
  // order_discount reported it as well, so payable took it off twice. A ₹150
  // cart at 20% stored 120/30/15 and charged ₹105, while the cart screen had
  // shown the customer ₹135.
  const p = await price({ businessDiscount: 20 });
  assert.strictEqual(p.order_amount, 150, "order_amount is GROSS goods");
  assert.strictEqual(p.order_discount, 30);
  assert.strictEqual(p.payable, 135, "150 + 15 delivery - 30 discount");
  assert.strictEqual(payableOf(p), p.payable);
});

test("the rain surcharge is added to the goods, and survives a coupon", async () => {
  const p = await price({ rainCharges: 20, code: "SAVE", campaign: campaign() });
  assert.strictEqual(p.order_amount, 170, "150 goods + 20 rain");
  assert.strictEqual(p.order_discount, 30);
  assert.strictEqual(p.payable, 155);
  assert.strictEqual(payableOf(p), p.payable);
});

test("columns always reconstruct the payable, whatever the combination", async () => {
  // The one property every downstream consumer relies on. If any branch of
  // priceCart ever stops satisfying it, the rider collects a different amount
  // from the one the customer agreed to.
  const combos = [
    { label: "plain" },
    { label: "flat coupon", code: "SAVE", campaign: campaign() },
    { label: "free delivery", code: "SAVE", campaign: campaign({ offer_type: "free_delivery" }) },
    { label: "vendor discount", businessDiscount: 15 },
    { label: "vendor discount + coupon", businessDiscount: 15, code: "SAVE", campaign: campaign() },
    { label: "rain", rainCharges: 20 },
    { label: "everything", businessDiscount: 10, rainCharges: 20, code: "SAVE", campaign: campaign() },
  ];

  for (const combo of combos) {
    const p = await price(combo);
    assert.strictEqual(payableOf(p), p.payable, `${combo.label}: columns disagree with payable`);
    assert.ok(p.payable > 0, `${combo.label}: payable must be positive`);
  }
});
