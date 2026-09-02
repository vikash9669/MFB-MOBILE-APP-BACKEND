const test = require("node:test");
const assert = require("node:assert");

const { PromoCampaign, PromoTarget } = require("../models");
const customerNotify = require("../util/customerNotify");
const { sweepOnce } = require("../util/promoNotificationSweeper");

// A mutable stand-in for a Sequelize instance: `.update()` mutates the same
// object sweepOnce() is holding, so assertions on it after the sweep see the
// real end state — unlike a spread copy, which would freeze fields at
// creation time.
const fakeCampaignInstance = (data) => {
  data.update = async (patch) => {
    Object.assign(data, patch);
  };
  return data;
};

test("sends a due campaign to every notifiable user and marks it sent", async () => {
  const real = {
    findOne: PromoCampaign.findOne,
    update: PromoCampaign.update,
    findByPk: PromoCampaign.findByPk,
    targetsFindAll: PromoTarget.findAll,
    allNotifiableUserIds: customerNotify.allNotifiableUserIds,
    notifyUser: customerNotify.notifyUser,
  };

  const campaign = fakeCampaignInstance({
    campaign_id: 7,
    title: "20% off today",
    body: "Order now",
    image: null,
    promo_code: "PROMO-ABC123",
    status: "scheduled",
    scheduled_at: new Date(Date.now() - 1000),
  });

  PromoCampaign.findOne = async () => campaign;
  PromoCampaign.update = async (patch, opts) => {
    assert.strictEqual(patch.status, "sending");
    assert.strictEqual(opts.where.campaign_id, 7);
    assert.strictEqual(opts.where.status, "scheduled");
    campaign.status = "sending";
    return [1];
  };
  PromoCampaign.findByPk = async (id) => (id === 7 ? campaign : null);
  PromoTarget.findAll = async () => [{ business_user_id: 42, product_id: null }];
  customerNotify.allNotifiableUserIds = async () => [1, 2, 3];

  const notified = [];
  customerNotify.notifyUser = async (userId, payload) => {
    notified.push({ userId, payload });
  };

  try {
    const result = await sweepOnce();
    assert.strictEqual(result.sent.sent, 3);
    assert.strictEqual(result.sent.target_count, 3);
    assert.strictEqual(notified.length, 3);
    assert.deepStrictEqual(
      notified.map((n) => n.userId).sort((a, b) => a - b),
      [1, 2, 3]
    );
    assert.strictEqual(notified[0].payload.category, "offers");
    assert.strictEqual(notified[0].payload.refBusinessUserId, 42);
    assert.strictEqual(notified[0].payload.refPromoCode, "PROMO-ABC123");
    assert.strictEqual(campaign.status, "sent");
    assert.strictEqual(campaign.sent_count, 3);
    assert.strictEqual(campaign.target_count, 3);
  } finally {
    PromoCampaign.findOne = real.findOne;
    PromoCampaign.update = real.update;
    PromoCampaign.findByPk = real.findByPk;
    PromoTarget.findAll = real.targetsFindAll;
    customerNotify.allNotifiableUserIds = real.allNotifiableUserIds;
    customerNotify.notifyUser = real.notifyUser;
  }
});

test("no due campaign: sweepOnce is a no-op", async () => {
  const real = PromoCampaign.findOne;
  PromoCampaign.findOne = async () => null;
  try {
    const result = await sweepOnce();
    assert.strictEqual(result.sent, null);
  } finally {
    PromoCampaign.findOne = real;
  }
});

test("losing the claim race (another instance already sent it) is a no-op, not a double-send", async () => {
  const realFindOne = PromoCampaign.findOne;
  const realUpdate = PromoCampaign.update;
  const realNotify = customerNotify.notifyUser;

  PromoCampaign.findOne = async () => ({ campaign_id: 9 });
  PromoCampaign.update = async () => [0]; // someone else's claim won
  let notifyCalled = false;
  customerNotify.notifyUser = async () => {
    notifyCalled = true;
  };

  try {
    const result = await sweepOnce();
    assert.strictEqual(result.sent, null);
    assert.strictEqual(notifyCalled, false);
  } finally {
    PromoCampaign.findOne = realFindOne;
    PromoCampaign.update = realUpdate;
    customerNotify.notifyUser = realNotify;
  }
});

test("a campaign spanning more than one vendor does not deep-link to any single restaurant", async () => {
  const real = {
    findOne: PromoCampaign.findOne,
    update: PromoCampaign.update,
    findByPk: PromoCampaign.findByPk,
    targetsFindAll: PromoTarget.findAll,
    allNotifiableUserIds: customerNotify.allNotifiableUserIds,
    notifyUser: customerNotify.notifyUser,
  };

  const campaign = fakeCampaignInstance({
    campaign_id: 8,
    title: "Big sale",
    body: null,
    image: null,
    promo_code: null,
    status: "scheduled",
    scheduled_at: new Date(Date.now() - 1000),
  });
  PromoCampaign.findOne = async () => campaign;
  PromoCampaign.update = async () => {
    campaign.status = "sending";
    return [1];
  };
  PromoCampaign.findByPk = async () => campaign;
  PromoTarget.findAll = async () => [
    { business_user_id: 1, product_id: null },
    { business_user_id: 2, product_id: null },
  ];
  customerNotify.allNotifiableUserIds = async () => [1];

  const notified = [];
  customerNotify.notifyUser = async (userId, payload) => notified.push(payload);

  try {
    await sweepOnce();
    assert.strictEqual(notified[0].refBusinessUserId, undefined);
  } finally {
    PromoCampaign.findOne = real.findOne;
    PromoCampaign.update = real.update;
    PromoCampaign.findByPk = real.findByPk;
    PromoTarget.findAll = real.targetsFindAll;
    customerNotify.allNotifiableUserIds = real.allNotifiableUserIds;
    customerNotify.notifyUser = real.notifyUser;
  }
});
