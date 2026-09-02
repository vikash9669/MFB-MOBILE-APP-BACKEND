// Promotional push campaigns — compose an offer/announcement, target one or
// more vendors/products, schedule it, and let util/promoNotificationSweeper.js
// send it to every customer with a registered device.
//
// A campaign's promo_code (when it carries an offer) rides the *existing*
// coupon pipeline — see util/coupon.js — so a customer redeems it through the
// same "Have a coupon code?" box that already exists in the cart, whether they
// typed it or the app pre-filled it from a notification tap.
const crypto = require("crypto");
const { Op } = require("sequelize");
const { PromoCampaign, PromoTarget, Product, Business } = require("../../models");

const EDITABLE_STATUSES = ["draft", "scheduled"];

const serializeCampaign = (c, targets = []) => ({
  campaign_id: c.campaign_id,
  title: c.title,
  body: c.body,
  image: c.image,
  offer_type: c.offer_type,
  offer_value: c.offer_value != null ? Number(c.offer_value) : null,
  min_order_amount: c.min_order_amount != null ? Number(c.min_order_amount) : null,
  promo_code: c.promo_code,
  usage_limit_per_user: c.usage_limit_per_user,
  expires_at: c.expires_at,
  scheduled_at: c.scheduled_at,
  sent_at: c.sent_at,
  status: c.status,
  target_count: c.target_count,
  sent_count: c.sent_count,
  failed_count: c.failed_count,
  created_at: c.created_at,
  targets: targets.map((t) => ({
    id: t.id,
    business_user_id: t.business_user_id,
    product_id: t.product_id,
  })),
});

// PROMO-XXXXXX, retried on the rare collision against the unique index.
const generatePromoCode = async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `PROMO-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await PromoCampaign.findOne({ where: { promo_code: code } });
    if (!exists) return code;
  }
  throw new Error("Could not generate a unique promo code");
};

const buildTargetRows = (campaign_id, targets) =>
  (Array.isArray(targets) ? targets : [])
    .filter((t) => t && (t.business_user_id != null || t.product_id != null))
    .map((t) => ({
      campaign_id,
      business_user_id: t.business_user_id ?? null,
      product_id: t.product_id ?? null,
    }));

// GET /admin/promos
exports.list = async (req, res) => {
  try {
    const campaigns = await PromoCampaign.findAll({
      order: [["created_at", "DESC"]],
    });
    // Targets are included here (not just on the detail endpoint) because the
    // panel's Edit dialog is opened straight from a list row — if this omitted
    // them, editing and saving a campaign would silently wipe its restaurant
    // targets, since the dialog would start from an empty target list.
    const targets = await PromoTarget.findAll({
      where: { campaign_id: campaigns.map((c) => c.campaign_id) },
    });
    const targetsByCampaign = new Map();
    for (const t of targets) {
      if (!targetsByCampaign.has(t.campaign_id)) targetsByCampaign.set(t.campaign_id, []);
      targetsByCampaign.get(t.campaign_id).push(t);
    }
    res.json({
      campaigns: campaigns.map((c) => serializeCampaign(c, targetsByCampaign.get(c.campaign_id) || [])),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos list ~ err:", err);
    res.status(500).json({ message: "Failed to load promotions" });
  }
};

// GET /admin/promos/:id
exports.detail = async (req, res) => {
  try {
    const campaign = await PromoCampaign.findByPk(req.params.id);
    if (campaign == null) {
      return res.status(404).json({ message: "Promotion not found" });
    }
    const targets = await PromoTarget.findAll({ where: { campaign_id: campaign.campaign_id } });
    res.json({ campaign: serializeCampaign(campaign, targets) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos detail ~ err:", err);
    res.status(500).json({ message: "Failed to load promotion" });
  }
};

// POST /admin/promos
// { title, body, image, offer_type, offer_value, min_order_amount,
//   usage_limit_per_user, expires_at, scheduled_at, send_now, targets }
exports.create = async (req, res) => {
  try {
    const {
      title,
      body,
      image,
      offer_type = "none",
      offer_value,
      min_order_amount,
      usage_limit_per_user,
      expires_at,
      scheduled_at,
      send_now,
      targets,
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }
    if (offer_type !== "none" && !(Number(offer_value) > 0) && offer_type !== "free_delivery") {
      return res.status(400).json({ message: "Enter an offer value" });
    }

    const willSchedule = Boolean(send_now) || Boolean(scheduled_at);
    const promo_code = offer_type !== "none" ? await generatePromoCode() : null;
    const now = new Date();

    const campaign = await PromoCampaign.create({
      title: String(title),
      body: body || null,
      image: image || null,
      offer_type,
      offer_value: offer_type === "none" ? null : Number(offer_value) || 0,
      min_order_amount: min_order_amount != null && min_order_amount !== "" ? Number(min_order_amount) : null,
      promo_code,
      usage_limit_per_user: Number(usage_limit_per_user) || 1,
      expires_at: expires_at ? new Date(expires_at) : null,
      scheduled_at: send_now ? now : scheduled_at ? new Date(scheduled_at) : now,
      status: willSchedule ? "scheduled" : "draft",
      created_by: req.panel.user_id,
      created_at: now,
      updated_at: now,
    });

    const targetRows = buildTargetRows(campaign.campaign_id, targets);
    if (targetRows.length) {
      await PromoTarget.bulkCreate(targetRows);
    }

    const saved = await PromoTarget.findAll({ where: { campaign_id: campaign.campaign_id } });
    res.status(201).json({ message: "Promotion saved", campaign: serializeCampaign(campaign, saved) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos create ~ err:", err);
    res.status(500).json({ message: "Failed to save promotion" });
  }
};

// PUT /admin/promos/:id — only while draft or scheduled (not once sending/sent).
exports.update = async (req, res) => {
  try {
    const campaign = await PromoCampaign.findByPk(req.params.id);
    if (campaign == null) {
      return res.status(404).json({ message: "Promotion not found" });
    }
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      return res.status(409).json({ message: `Cannot edit a promotion that is already ${campaign.status}` });
    }

    const patch = { updated_at: new Date() };
    const b = req.body || {};
    if (b.title !== undefined) patch.title = String(b.title);
    if (b.body !== undefined) patch.body = b.body || null;
    if (b.image !== undefined) patch.image = b.image || null;
    if (b.offer_type !== undefined) patch.offer_type = b.offer_type;
    if (b.offer_value !== undefined) patch.offer_value = b.offer_type === "none" ? null : Number(b.offer_value) || 0;
    if (b.min_order_amount !== undefined) {
      patch.min_order_amount = b.min_order_amount != null && b.min_order_amount !== "" ? Number(b.min_order_amount) : null;
    }
    if (b.usage_limit_per_user !== undefined) patch.usage_limit_per_user = Number(b.usage_limit_per_user) || 1;
    if (b.expires_at !== undefined) patch.expires_at = b.expires_at ? new Date(b.expires_at) : null;

    // A campaign that just gained an offer needs a code; one that had its offer
    // removed keeps its existing code inert (offer_type governs redemption).
    if (patch.offer_type && patch.offer_type !== "none" && !campaign.promo_code) {
      patch.promo_code = await generatePromoCode();
    }

    if (b.send_now) {
      patch.scheduled_at = new Date();
      patch.status = "scheduled";
    } else if (b.scheduled_at !== undefined) {
      patch.scheduled_at = new Date(b.scheduled_at);
      patch.status = "scheduled";
    }

    await campaign.update(patch);

    if (b.targets !== undefined) {
      await PromoTarget.destroy({ where: { campaign_id: campaign.campaign_id } });
      const targetRows = buildTargetRows(campaign.campaign_id, b.targets);
      if (targetRows.length) await PromoTarget.bulkCreate(targetRows);
    }

    const targets = await PromoTarget.findAll({ where: { campaign_id: campaign.campaign_id } });
    res.json({ message: "Promotion updated", campaign: serializeCampaign(campaign, targets) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos update ~ err:", err);
    res.status(500).json({ message: "Failed to update promotion" });
  }
};

// POST /admin/promos/:id/cancel
exports.cancel = async (req, res) => {
  try {
    const campaign = await PromoCampaign.findByPk(req.params.id);
    if (campaign == null) {
      return res.status(404).json({ message: "Promotion not found" });
    }
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      return res.status(409).json({ message: `Cannot cancel a promotion that is already ${campaign.status}` });
    }
    await campaign.update({ status: "cancelled", updated_at: new Date() });
    res.json({ message: "Promotion cancelled" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos cancel ~ err:", err);
    res.status(500).json({ message: "Failed to cancel promotion" });
  }
};

// DELETE /admin/promos/:id — only while still a draft.
exports.remove = async (req, res) => {
  try {
    const campaign = await PromoCampaign.findByPk(req.params.id);
    if (campaign == null) {
      return res.status(404).json({ message: "Promotion not found" });
    }
    if (campaign.status !== "draft") {
      return res.status(409).json({ message: "Only a draft promotion can be deleted — cancel it instead" });
    }
    await campaign.destroy();
    res.json({ message: "Promotion deleted" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos remove ~ err:", err);
    res.status(500).json({ message: "Failed to delete promotion" });
  }
};

// GET /admin/promos/product-options?vendor_id=&search=
//
// A separate, inclusive picker for the target selector. GET /admin/products/search
// is built for "copy a product FROM someone else's catalogue" and deliberately
// EXCLUDES the given vendor's own products — wrong shape for "pick items from
// the vendor(s) I just selected," so this is its own endpoint rather than a
// repurposed one.
exports.productOptions = async (req, res) => {
  try {
    const vendorId = req.query.vendor_id ? Number(req.query.vendor_id) : null;
    const term = String(req.query.search || "").trim();

    const where = {};
    if (vendorId) where.product_user_id = vendorId;
    if (term.length >= 2) where.product_name = { [Op.like]: `%${term}%` };
    if (!vendorId && term.length < 2) {
      return res.json({ products: [] });
    }

    const rows = await Product.findAll({
      where,
      order: [["product_name", "ASC"]],
      limit: 100,
      raw: true,
    });

    const vendorIds = [...new Set(rows.map((r) => r.product_user_id).filter(Boolean))];
    const businesses = vendorIds.length
      ? await Business.findAll({ where: { user_id: vendorIds }, attributes: ["user_id", "business_name"], raw: true })
      : [];
    const bizById = Object.fromEntries(businesses.map((b) => [b.user_id, b.business_name]));

    res.json({
      products: rows.map((p) => ({
        product_id: p.product_id,
        product_name: p.product_name,
        product_mrp: p.product_mrp,
        business_user_id: p.product_user_id,
        business_name: bizById[p.product_user_id] || null,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin promos product-options ~ err:", err);
    res.status(500).json({ message: "Failed to search products" });
  }
};
