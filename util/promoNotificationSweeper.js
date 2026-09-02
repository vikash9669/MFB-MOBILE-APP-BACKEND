// Sends a scheduled promo campaign — admin-composed in the panel, broadcast to
// every customer who has a registered device, via the same FCM pipeline every
// other customer push already goes through (util/customerNotify.js).
//
// Same shape as the other sweepers in this file group (util/paymentSweeper.js,
// util/orderAcceptSweeper.js): a timer that never throws, and an exported
// sweepOnce() the tests drive directly.
const { Op } = require("sequelize");
const { PromoCampaign, PromoTarget } = require("../models");
// Required as a module object, not destructured, so tests can monkey-patch
// customerNotify.notifyUser / .allNotifiableUserIds the same way the other
// sweeper tests monkey-patch a model's static methods (see
// test/orderAcceptSweeper.test.js) — a destructured binding would freeze in
// whatever the function was at require time.
const customerNotify = require("./customerNotify");
const { assetUrl } = require("./assetUrl");

const EVERY_MS = 30000;
// Fan-out concurrency. FCM has no true multicast (see util/fcm.js), so a
// broadcast to a large user base is one HTTP call per device; batching keeps a
// big campaign from opening thousands of connections at once.
const BATCH = Number(process.env.PROMO_SEND_BATCH || 25);

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * Claims one due campaign so two server instances can't both send it —
 * same optimistic-update-then-check-affected-rows pattern paymentSettlement.js
 * uses for payment intents.
 */
async function claimDueCampaign() {
  const due = await PromoCampaign.findOne({
    where: { status: "scheduled", scheduled_at: { [Op.lte]: new Date() } },
    order: [["scheduled_at", "ASC"]],
  });
  if (due == null) return null;

  const [claimed] = await PromoCampaign.update(
    { status: "sending" },
    { where: { campaign_id: due.campaign_id, status: "scheduled" } }
  );
  if (claimed === 0) return null; // another instance won the race

  return PromoCampaign.findByPk(due.campaign_id);
}

/** Vendor/product ids to attach as the deep-link, only when unambiguous. */
function deepLinkData(targets) {
  const vendorIds = [...new Set(targets.map((t) => t.business_user_id).filter((v) => v != null))];
  const productIds = [...new Set(targets.map((t) => t.product_id).filter((v) => v != null))];

  // A single product target deep-links straight to its vendor's menu (with the
  // product id along for the ride, unused for now but harmless to carry).
  // Anything spanning more than one vendor can't deep-link to one restaurant,
  // so it's left to open the notification centre instead — see index.js.
  if (vendorIds.length === 1) {
    return { vendor_id: vendorIds[0], product_id: productIds.length === 1 ? productIds[0] : undefined };
  }
  return {};
}

async function sendCampaign(campaign) {
  const targets = await PromoTarget.findAll({ where: { campaign_id: campaign.campaign_id }, raw: true });
  const userIds = await customerNotify.allNotifiableUserIds();
  const image = campaign.image ? assetUrl("promos", campaign.image) : null;
  const { vendor_id, product_id } = deepLinkData(targets);

  let sent = 0;
  let failed = 0;

  for (const batch of chunk(userIds, BATCH)) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      batch.map(async (userId) => {
        try {
          await customerNotify.notifyUser(userId, {
            category: "offers",
            icon: "pricetag-outline",
            title: campaign.title,
            body: campaign.body || undefined,
            image,
            refBusinessUserId: vendor_id,
            refPromoCode: campaign.promo_code || undefined,
            data: {
              campaign_id: campaign.campaign_id,
              ...(product_id ? { product_id } : {}),
            },
          });
          sent += 1;
        } catch (err) {
          failed += 1;
          console.log(
            `MFB-error-logs ~ promo sweeper ~ notify user ${userId} ~`,
            err.message
          );
        }
      })
    );
  }

  await campaign.update({
    status: "sent",
    sent_at: new Date(),
    target_count: userIds.length,
    sent_count: sent,
    failed_count: failed,
    updated_at: new Date(),
  });

  return { campaign_id: campaign.campaign_id, target_count: userIds.length, sent, failed };
}

/** One sweep: claims and sends at most one due campaign. Never throws. */
async function sweepOnce() {
  const campaign = await claimDueCampaign();
  if (campaign == null) return { sent: null };

  try {
    const result = await sendCampaign(campaign);
    console.log(
      `MFB ~ promo sweeper ~ sent campaign #${result.campaign_id} to ${result.sent}/${result.target_count} device-holders` +
        (result.failed ? ` (${result.failed} failed)` : "")
    );
    return { sent: result };
  } catch (err) {
    // Never leave a campaign stuck in "sending" — a human should see "failed"
    // and decide whether to reschedule it, not find it silently frozen.
    await campaign.update({ status: "failed", updated_at: new Date() }).catch(() => {});
    console.log("MFB-error-logs ~ promo sweeper ~ send failed ~", err.message);
    return { sent: null, error: err.message };
  }
}

function startPromoNotificationSweeper() {
  let warned = false;
  const tick = () =>
    sweepOnce().catch((err) => {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ promo sweeper idle: " + (err.original?.sqlMessage || err.message) + ". Promotions will not be sent."
      );
    });
  tick();
  const timer = setInterval(tick, EVERY_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = { sweepOnce, startPromoNotificationSweeper };
