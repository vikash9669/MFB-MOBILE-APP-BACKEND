// Endpoints the web storefront needs that the mobile customer app never did.
// The storefront is the "/" tree of MFB-ADMIN-PANEL, which also serves the
// staff portals. Everything else it uses already exists — /restaurant, /menu,
// /products, /address, /user/create-order, /user/orders and the auth routes are
// shared with the app.
const { Op } = require("sequelize");
const { Product, Business, User } = require("../models");
const sequelize = require("../util/database");

const num = (v) => Number(v || 0);

// GET /search?q=&limit=
// The PHP storefront's Pages::Search. The mobile app has no equivalent — it
// browses by restaurant — so this is new.
exports.searchProducts = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ query: q, products: [], restaurants: [] });
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    const [products, restaurants] = await Promise.all([
      Product.findAll({
        where: { product_name: { [Op.like]: `%${q}%` } },
        attributes: ["product_id", "product_name", "product_mrp", "product_user_id"],
        limit,
        raw: true,
      }),
      Business.findAll({
        where: { business_name: { [Op.like]: `%${q}%` }, business_status: 1 },
        attributes: ["business_id", "user_id", "business_name", "business_slug"],
        limit,
        raw: true,
      }),
    ]);

    // Attach the restaurant each product belongs to, so a result is clickable
    // through to its menu.
    const vendorIds = [...new Set(products.map((p) => p.product_user_id).filter(Boolean))];
    const vendors = vendorIds.length
      ? await Business.findAll({
          where: { user_id: vendorIds },
          attributes: ["user_id", "business_name", "business_slug"],
          raw: true,
        })
      : [];
    const byUser = Object.fromEntries(vendors.map((v) => [v.user_id, v]));

    res.json({
      query: q,
      products: products.map((p) => ({
        product_id: p.product_id,
        product_name: p.product_name,
        product_mrp: num(p.product_mrp),
        business_user_id: p.product_user_id,
        business_name: byUser[p.product_user_id]?.business_name ?? null,
        business_slug: byUser[p.product_user_id]?.business_slug ?? null,
      })),
      restaurants: restaurants.map((b) => ({
        business_id: b.business_id,
        user_id: b.user_id,
        business_name: b.business_name,
        business_slug: b.business_slug,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ storefront search ~ err:", err);
    res.status(500).json({ message: "Search failed" });
  }
};

// GET /user/cashback — the storefront's User::Cashback page.
exports.getCashback = async (req, res) => {
  try {
    const { user_id } = req.user;

    // store_users_cashback has no Sequelize model (it is not used anywhere else
    // in the API), so this reads it directly. Parameterised, read-only.
    const [rows] = await sequelize.query(
      `SELECT order_id, referral_id, cashback_earned, cashback_balance,
              cashback_type, cashback_status, cashback_time
         FROM store_users_cashback
        WHERE user_id = ?
        ORDER BY cashback_time DESC
        LIMIT 100`,
      { replacements: [user_id] }
    );

    const user = await User.findByPk(user_id, { attributes: ["user_cashback"] });

    res.json({
      // The running balance lives on the user row; the table is the ledger.
      balance: num(user?.user_cashback),
      entries: rows.map((r) => ({
        order_id: r.order_id,
        referral_id: r.referral_id,
        earned: num(r.cashback_earned),
        balance: num(r.cashback_balance),
        type: Number(r.cashback_type),
        status: Number(r.cashback_status),
        created_at: r.cashback_time,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ storefront cashback ~ err:", err);
    res.status(500).json({ message: "Failed to load cashback" });
  }
};
