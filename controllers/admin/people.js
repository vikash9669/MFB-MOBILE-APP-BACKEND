// Customers, Vendors and Riders — the React equivalent of
// administration/Users (Index/Users/Riders/Customers), Vendor and Rider.
//
// All three are rows in store_users, separated by user_role:
//   3 = rider, 4 = vendor, 12 = customer, 0/1/2 = staff.
const { Op, fn, col } = require("sequelize");
const {
  User,
  Business,
  UserBank,
  StoreOrders,
  DeliveryPartner,
} = require("../../models");
const { VENDOR_ROLE, RIDER_ROLE, ADMIN_ROLES } = require("../../middlewares/verifyAdmin");
const { readPin } = require("../../util/vendorColumns");

const CUSTOMER_ROLE = 12;
const num = (v) => Number(v || 0);

const ROLE_FILTERS = {
  customers: { user_role: CUSTOMER_ROLE },
  vendors: { user_role: VENDOR_ROLE },
  riders: { user_role: RIDER_ROLE },
  staff: { user_role: { [Op.in]: ADMIN_ROLES } },
};

// store_users carries three independent switches, and the PHP vendors list drew
// one toggle for each. They are NOT interchangeable:
//
//   user_status  1/2  — the account itself; 2 is the panel's "disabled"
//   user_active  1/0  — whether the vendor is listed at all. controllers/
//                       products.js drops any vendor whose user_active is falsy
//                       from the app's restaurant list, as did the storefront.
//   user_login   1/0  — whether the store is open right now. The customer app
//                       reads exactly this in helpers/utils.js `isShopOpen`.
//
// business_status is deliberately NOT one of them: the PHP panel only ever read
// it, adding it to bank_status to draw a completeness indicator. Writing it
// would both corrupt that signal and delist the vendor, since products.js
// filters the listing on `business_status: true`.
const serialize = (u) => ({
  user_id: u.user_id,
  name: u.user_name,
  email: u.user_email,
  phone: u.user_phone,
  role: Number(u.user_role),
  address: u.user_address,
  city: u.user_city,
  zip: u.user_zip,
  image: u.user_image,
  status: Number(u.user_status),
  active: Number(u.user_active),
  /** Store open right now — store_users.user_login. */
  store_open: Number(u.user_login) === 1,
  registered: u.user_registered,
  last_login: u.user_last_login,
});

// GET /admin/people/:group  (customers | vendors | riders | staff)
exports.list = async (req, res) => {
  try {
    const group = String(req.params.group);
    const roleWhere = ROLE_FILTERS[group];
    if (!roleWhere) {
      return res.status(400).json({ message: "Unknown group" });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const where = { ...roleWhere };
    if (req.query.search) {
      const s = String(req.query.search).trim();
      const matches = [
        { user_name: { [Op.like]: `%${s}%` } },
        { user_phone: { [Op.like]: `%${s}%` } },
        { user_email: { [Op.like]: `%${s}%` } },
      ];

      // A vendor's RESTAURANT name is not on store_users at all — it lives in
      // store_users_business.business_name, while user_name holds the owner's
      // own name. So searching the vendors list for "Chai Sutta Bar" matched
      // nothing, even though that is the only name staff know the vendor by and
      // the one the list displays.
      //
      // Resolved to user ids first rather than joined: the businesses are
      // loaded further down, AFTER pagination, so filtering them there would
      // only ever see the 25 rows already on the page.
      if (group === "vendors") {
        const businesses = await Business.findAll({
          attributes: ["user_id"],
          where: { business_name: { [Op.like]: `%${s}%` } },
          // A term like "a" would otherwise pull every vendor id into an IN
          // clause. Vendors number in the dozens today, but this list grows.
          limit: 500,
          raw: true,
        });
        const ids = [...new Set(businesses.map((b) => b.user_id))].filter(Boolean);
        if (ids.length) {
          matches.push({ user_id: { [Op.in]: ids } });
        }
      }

      where[Op.and] = [{ [Op.or]: matches }];
    }
    if (req.query.status !== undefined && req.query.status !== "") {
      where.user_status = Number(req.query.status);
    }
    // user_active — the "Listed" switch, independent of user_status.
    if (req.query.listed !== undefined && req.query.listed !== "") {
      where.user_active = Number(req.query.listed);
    }
    // Riders exist in two places; "source" narrows to the ones that also have a
    // delivery-app account (matched on phone, as everywhere else) or the ones
    // that do not. Filtered here rather than in the client so it applies across
    // every page, not just the one on screen.
    if (group === "riders" && (req.query.source === "app" || req.query.source === "panel")) {
      const partners = await DeliveryPartner.findAll({
        attributes: ["dp_phone"],
        raw: true,
      });
      const phones = [
        ...new Set(
          partners
            .map((p) => String(p.dp_phone || "").replace(/\D/g, "").slice(-10))
            .filter(Boolean)
        ),
      ];
      if (req.query.source === "app") {
        // No app partners at all means nothing can match.
        where.user_phone = phones.length ? { [Op.in]: phones } : { [Op.in]: ["\u0000"] };
      } else if (phones.length) {
        where.user_phone = { [Op.notIn]: phones };
      }
    }

    const { count, rows } = await User.findAndCountAll({
      where,
      order: [["user_id", "DESC"]],
      limit,
      offset: (page - 1) * limit,
      raw: true,
    });

    let extra = {};
    if (group === "vendors") {
      const ids = rows.map((r) => r.user_id);
      const [businesses, banks] = await Promise.all([
        Business.findAll({ where: { user_id: ids }, raw: true }),
        UserBank.findAll({ where: { user_id: ids }, raw: true }),
      ]);
      const bankById = Object.fromEntries(
        banks.map((b) => [b.user_id, Number(b.bank_status)])
      );
      extra = Object.fromEntries(
        businesses.map((b) => [
          b.user_id,
          {
            business_name: b.business_name,
            business_status: Number(b.business_status),
            business_open: b.business_open,
            business_close: b.business_close,
            commission: num(b.business_commision),
            discount: num(b.business_discount),
            // business_status + bank_status, the sum the PHP vendors list drew
            // as an empty / half / full battery. 0-2: how much of the vendor's
            // onboarding is actually filled in.
            onboarding: Number(b.business_status) + (bankById[b.user_id] || 0),
          },
        ])
      );
    }

    res.json({
      people: rows.map((u) => ({ ...serialize(u), ...(extra[u.user_id] || {}) })),
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin people list ~ err:", err);
    res.status(500).json({ message: "Failed to load list" });
  }
};

// GET /admin/people/detail/:id — profile + business + bank + order stats.
exports.detail = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, { raw: true });
    if (user == null) {
      return res.status(404).json({ message: "Not found" });
    }
    const role = Number(user.user_role);

    const [business, bank, pin] = await Promise.all([
      Business.findOne({ where: { user_id: user.user_id }, raw: true }),
      UserBank.findOne({ where: { user_id: user.user_id }, raw: true }),
      // Off the User model on purpose (util/vendorColumns.js), so it is fetched
      // rather than read off `user`. Returns null on an unmigrated database.
      readPin(user.user_id),
    ]);

    // Which column links this person to orders depends on what they are.
    let orderWhere = null;
    if (role === CUSTOMER_ROLE) orderWhere = { customer_id: user.user_id };
    else if (role === VENDOR_ROLE) orderWhere = { vendor_id: user.user_id };
    else if (role === RIDER_ROLE) orderWhere = { rider_id: user.user_id };

    let stats = null;
    if (orderWhere) {
      const [agg] = await StoreOrders.findAll({
        attributes: [
          [fn("COUNT", col("order_id")), "orders"],
          [fn("COALESCE", fn("SUM", col("order_amount")), 0), "amount"],
        ],
        where: orderWhere,
        raw: true,
      });
      stats = { orders: num(agg?.orders), amount: num(agg?.amount) };
    }

    res.json({
      person: serialize(user),
      // The kitchen's map pin, or null when nobody has placed one — which the
      // panel shows as "geocoded from the address" rather than as an error.
      pin,
      // Onboarding completeness, the PHP battery icon: business_status +
      // bank_status. Read-only — neither panel ever wrote these.
      onboarding: business ? Number(business.business_status) + Number(bank?.bank_status || 0) : null,
      business: business
        ? {
            business_id: business.business_id,
            name: business.business_name,
            slug: business.business_slug,
            status: Number(business.business_status),
            open: business.business_open,
            close: business.business_close,
            commission: num(business.business_commision),
            discount: num(business.business_discount),
            rain_charges: num(business.business_rain_charges),
            menu_types: business.business_menu_types,
            fssai: business.business_fssai,
            gstin: business.business_gstin,
          }
        : null,
      bank: bank
        ? {
            bank_name: bank.bank_name,
            account_name: bank.bank_account_name,
            account: bank.bank_account,
            ifsc: bank.bank_ifsc,
            status: Number(bank.bank_status),
          }
        : null,
      stats,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin person detail ~ err:", err);
    res.status(500).json({ message: "Failed to load profile" });
  }
};

// PUT /admin/people/:id/status  { status } — Ajax::Status equivalent.
exports.setStatus = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (user == null) {
      return res.status(404).json({ message: "Not found" });
    }
    await user.update({ user_status: Number(req.body.status) ? 1 : 0 });
    res.json({ message: "Status updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin set status ~ err:", err);
    res.status(500).json({ message: "Failed to update status" });
  }
};

// PUT /admin/vendors/:id/store  { open } — administration/Vendor::storeClose.
// PUT /admin/vendors/:id/store  { open } — the `.login` toggle on the PHP
// vendors list, and administration/Vendor::storeClose.
//
// Writes store_users.user_login, which is what actually decides "open": the
// customer app's helpers/utils.js `isShopOpen` returns false the moment
// user_login is falsy. An earlier version of this endpoint wrote
// business_status instead — that never closed anything, and because
// controllers/products.js filters the vendor listing on `business_status: true`
// it removed the restaurant from the app altogether.
exports.setStoreOpen = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (user == null) {
      return res.status(404).json({ message: "Vendor not found" });
    }
    if (Number(user.user_role) !== VENDOR_ROLE) {
      return res.status(400).json({ message: "That account is not a vendor" });
    }
    await user.update({ user_login: Number(req.body.open) ? 1 : 0 });
    res.json({
      message: Number(req.body.open) ? "Store opened" : "Store closed",
      store_open: Boolean(Number(req.body.open)),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin store open ~ err:", err);
    res.status(500).json({ message: "Failed to update store" });
  }
};

// PUT /admin/people/:id/active  { active } — the `.user_active` toggle, the
// third switch on the PHP vendors list and the one with the widest blast
// radius: controllers/products.js drops any vendor whose user_active is falsy
// from the app's restaurant listing entirely, so this is "listed" rather than
// "open".
exports.setActive = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (user == null) {
      return res.status(404).json({ message: "Not found" });
    }
    const active = Number(req.body.active) ? 1 : 0;
    await user.update({ user_active: active });

    // For a RIDER, "Listed" has to mean listed to the dispatch engine too.
    //
    // user_active and dp_active are separate columns on purpose (see
    // models/delivery_partner.js), but separate is not the same as
    // unreachable: dispatch reads only dp_active, and until now NOTHING an
    // operator could click wrote it. A rider could be approved, Listed, Active
    // and online, and the engine still could not see them — with no toggle
    // anywhere to fix it. On the clone that was 78 of 94 approved riders.
    //
    // Scoped to user_role 3 so a customer or vendor row is never given
    // delivery flags. Best-effort: the listing change is already committed and
    // must not be reported as failed because the mirror was.
    let dispatchable = null;
    if (Number(user.user_role) === RIDER_ROLE) {
      try {
        await DeliveryPartner.update(
          { dp_active: active },
          { where: { dp_id: user.user_id } }
        );
        dispatchable = active === 1;
      } catch (err) {
        console.log("MFB-error-logs ~ set active dp mirror ~ err:", err);
      }
    }

    res.json({
      message: active ? "Listed" : "Delisted",
      active,
      // Lets the panel say "visible to dispatch" rather than leaving an
      // operator to guess whether listing a rider actually did anything.
      dispatchable,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin set active ~ err:", err);
    res.status(500).json({ message: "Failed to update" });
  }
};
