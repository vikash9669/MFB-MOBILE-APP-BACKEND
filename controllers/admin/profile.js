// Profile — administration/Profile (Index's basic / business / bank / areas
// tabs, plus AdminLogin).
//
// The "areas" tab is role 0 only, exactly as the PHP guarded it. It manages
// store_users_area: which pincodes a vendor delivers to, the minimum order,
// the delivery charge, and the value above which delivery is free.
const jwt = require("jsonwebtoken");
const sequelize = require("../../util/database");
const { User, Business, UserBank, Location, Area } = require("../../models");
const { parsePin, writePin, readPin } = require("../../util/vendorColumns");
const {
  canUsePanel,
  scopeFor,
  isAdminRole,
  VENDOR_ROLE,
} = require("../../middlewares/verifyAdmin");

const num = (v) => Number(v || 0);

// The PHP defaults, from Profile::Index.
const AREA_DEFAULTS = { checkout: 300, charge: 30, charge_free: 1000 };

/** Which user this request may read/write: your own row, or anyone if admin. */
function targetId(req) {
  const requested = req.params.id ? Number(req.params.id) : null;
  if (requested == null || requested === req.panel.user_id) return req.panel.user_id;
  return isAdminRole(req.panel.role) ? requested : null;
}

// GET /admin/profile/:id?
exports.get = async (req, res) => {
  try {
    const id = targetId(req);
    if (id == null) return res.status(403).json({ message: "Not permitted" });

    const user = await User.findByPk(id, { raw: true });
    if (user == null) return res.status(404).json({ message: "Not found" });

    const [business, bank, areas] = await Promise.all([
      Business.findOne({ where: { user_id: id }, raw: true }),
      UserBank.findOne({ where: { user_id: id }, raw: true }),
      Area.findAll({ where: { area_user_id: id }, raw: true }),
    ]);

    // The PHP page offered the cities matching the user's own pincode.
    const cities = user.user_zip
      ? await Location.findAll({ where: { location_pincode: user.user_zip }, raw: true })
      : [];

    res.json({
      basic: {
        user_id: user.user_id,
        name: user.user_name,
        email: user.user_email,
        phone: user.user_phone,
        role: Number(user.user_role),
        address: user.user_address,
        landmark: user.user_landmark,
        city: user.user_city,
        state: user.user_state,
        zip: user.user_zip,
        image: user.user_image,
        /** basic[phone_1] — the alternate number the PHP form collected. */
        phone_1: user.user_phone_1,
        // The map pin, or null when nobody has placed one. Fetched separately
        // because the columns are off the User model — util/vendorColumns.js.
        pin: await readPin(user.user_id),
      },
      business: business
        ? {
            name: business.business_name,
            slug: business.business_slug,
            status: Number(business.business_status),
            open: business.business_open,
            close: business.business_close,
            discount: num(business.business_discount),
            commission: num(business.business_commision),
            rain_charges: num(business.business_rain_charges),
            menu_types: business.business_menu_types,
            fssai: business.business_fssai,
            gstin: business.business_gstin,
            offer_text: business.business_offer_text,
            // The registration block the PHP form collected: data[type] chose
            // sole proprietor (0) or company (1), and a company additionally had
            // to supply company PAN, TAN and CIN.
            type: Number(business.business_type),
            personal_pan: business.business_personal_pan,
            company_pan: business.business_company_pan,
            tan: business.business_tan,
            cin: business.business_cin,
            order: Number(business.business_order),
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
      areas: areas.map((a) => ({
        area_id: a.area_id,
        pincode: a.area_pincode,
        checkout: num(a.area_checkout),
        charge: num(a.area_charge),
        charge_free: num(a.area_charge_free),
        status: Number(a.area_status),
      })),
      cities: cities.map((c) => ({
        location_id: c.location_id,
        name: c.location_name,
        pincode: c.location_pincode,
      })),
      // Only a level-0 admin ever saw the areas tab.
      can_edit_areas: Number(req.panel.role) === 0,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ profile get ~ err:", err);
    res.status(500).json({ message: "Failed to load profile" });
  }
};

// PUT /admin/profile/basic/:id?
exports.updateBasic = async (req, res) => {
  try {
    const id = targetId(req);
    if (id == null) return res.status(403).json({ message: "Not permitted" });
    const user = await User.findByPk(id);
    if (user == null) return res.status(404).json({ message: "Not found" });

    const patch = {};
    for (const [field, column] of [
      ["name", "user_name"],
      ["email", "user_email"],
      ["address", "user_address"],
      ["landmark", "user_landmark"],
      ["city", "user_city"],
      ["zip", "user_zip"],
    ]) {
      if (req.body[field] !== undefined) patch[column] = req.body[field];
    }
    if (req.body.state !== undefined) patch.user_state = num(req.body.state);
    if (req.body.image !== undefined) patch.user_image = req.body.image;

    // basic[phone_1]. user_phone stays put — it is the sign-in identifier, and
    // the PHP form did not let this screen change it either.
    if (req.body.phone_1 !== undefined) {
      const alt = String(req.body.phone_1).replace(/\D/g, "");
      if (alt && alt.length !== 10) {
        return res.status(422).json({
          message: "Check the highlighted fields",
          errors: { phone_1: "Alternate phone must be 10 digits" },
        });
      }
      patch.user_phone_1 = alt;
    }

    await user.update(patch);

    // The map pin. Silence leaves it alone — this form saves a name or a
    // landmark far more often than it moves a kitchen, and an untouched pin
    // must survive that. `clear_pin` is the explicit way back to none.
    let pinSaved = null;
    if (req.body.clear_pin === true) {
      pinSaved = (await writePin(id, null)).saved;
    } else {
      const pin = parsePin(req.body);
      if (pin) pinSaved = (await writePin(id, pin)).saved;
    }

    res.json({ message: "Profile updated", pin_saved: pinSaved });
  } catch (err) {
    console.log("MFB-error-logs ~ profile updateBasic ~ err:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
};

// PUT /admin/profile/business/:id?
exports.updateBusiness = async (req, res) => {
  try {
    const id = targetId(req);
    if (id == null) return res.status(403).json({ message: "Not permitted" });
    const business = await Business.findOne({ where: { user_id: id } });
    if (business == null) return res.status(404).json({ message: "No store for this account" });

    const patch = {};
    for (const [field, column] of [
      ["name", "business_name"],
      ["open", "business_open"],
      ["close", "business_close"],
      ["menu_types", "business_menu_types"],
      ["fssai", "business_fssai"],
      ["gstin", "business_gstin"],
      ["offer_text", "business_offer_text"],
    ]) {
      if (req.body[field] !== undefined) patch[column] = req.body[field];
    }
    // Registration details — Profile::BusinessInfo. A company (type 1) had to
    // supply company PAN, TAN and CIN; a sole proprietor did not.
    for (const [field, column] of [
      ["personal_pan", "business_personal_pan"],
      ["company_pan", "business_company_pan"],
      ["tan", "business_tan"],
      ["cin", "business_cin"],
    ]) {
      if (req.body[field] !== undefined) patch[column] = req.body[field] || null;
    }
    if (req.body.type !== undefined) patch.business_type = Number(req.body.type) ? 1 : 0;
    if (req.body.order !== undefined) patch.business_order = num(req.body.order);

    const isCompany =
      req.body.type !== undefined ? Number(req.body.type) === 1 : Number(business.business_type) === 1;
    if (isCompany) {
      const errors = {};
      for (const field of ["company_pan", "tan", "cin"]) {
        const value = req.body[field] !== undefined ? req.body[field] : business[`business_${field}`];
        if (!value) errors[field] = "Required for a registered company";
      }
      if (Object.keys(errors).length > 0) {
        return res.status(422).json({ message: "Check the highlighted fields", errors });
      }
    }

    if (req.body.discount !== undefined) patch.business_discount = num(req.body.discount);
    if (req.body.rain_charges !== undefined) patch.business_rain_charges = num(req.body.rain_charges);
    // Commission is the platform's cut — only staff may change it.
    if (req.body.commission !== undefined && isAdminRole(req.panel.role)) {
      patch.business_commision = num(req.body.commission);
    }

    await business.update(patch);
    res.json({ message: "Store details updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ profile updateBusiness ~ err:", err);
    res.status(500).json({ message: "Failed to update store" });
  }
};

// PUT /admin/profile/areas/:id — role 0 only (Profile::Index 'areas').
//
// The PHP version DELETEd every row for the user then re-INSERTed the posted
// set. That is kept, but inside a transaction — the original had no rollback,
// so a failure mid-loop left the vendor with no delivery areas at all.
exports.saveAreas = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const id = Number(req.params.id);
    const rows = Array.isArray(req.body.areas) ? req.body.areas : null;
    if (!rows) {
      await t.rollback();
      return res.status(400).json({ message: "Send an areas array" });
    }

    await Area.destroy({ where: { area_user_id: id }, transaction: t });

    for (const a of rows) {
      if (!a.area_id || !a.pincode) continue;
      await Area.create(
        {
          area_id: Number(a.area_id),
          area_user_id: id,
          area_pincode: String(a.pincode),
          area_checkout: a.checkout === "" || a.checkout == null ? AREA_DEFAULTS.checkout : num(a.checkout),
          area_charge: a.charge === "" || a.charge == null ? AREA_DEFAULTS.charge : num(a.charge),
          area_charge_free:
            a.charge_free === "" || a.charge_free == null ? AREA_DEFAULTS.charge_free : num(a.charge_free),
          area_status: 1,
        },
        { transaction: t }
      );
    }

    await t.commit();
    res.json({ message: "Delivery areas saved", count: rows.length });
  } catch (err) {
    await t.rollback();
    console.log("MFB-error-logs ~ profile saveAreas ~ err:", err);
    res.status(500).json({ message: "Failed to save delivery areas" });
  }
};

// POST /admin/profile/impersonate/:id — administration/Profile::AdminLogin.
//
// Lets an admin open a vendor's or rider's portal to see exactly what they see.
// The PHP swapped the session user and stashed admin_id; here it mints a short
// token carrying impersonated_by, so the action is attributable in logs.
exports.impersonate = async (req, res) => {
  try {
    const target = await User.findByPk(req.params.id);
    if (target == null) return res.status(404).json({ message: "User not found" });
    if (!canUsePanel(target.user_role)) {
      return res.status(400).json({ message: "That account cannot use the panel" });
    }
    if (isAdminRole(target.user_role)) {
      return res.status(400).json({ message: "Refusing to impersonate another admin" });
    }

    const token = jwt.sign(
      {
        scope: "admin_panel",
        portal: scopeFor(target.user_role),
        user_id: target.user_id,
        role: Number(target.user_role),
        name: target.user_name,
        impersonated_by: req.panel.user_id,
      },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "1h" }
    );

    const business =
      Number(target.user_role) === VENDOR_ROLE
        ? await Business.findOne({ where: { user_id: target.user_id } })
        : null;

    res.json({
      token,
      user: {
        portal: scopeFor(target.user_role),
        user_id: target.user_id,
        name: target.user_name,
        email: target.user_email,
        phone: target.user_phone,
        role: Number(target.user_role),
        city: target.user_city,
        state: target.user_state,
        image: target.user_image,
        status: target.user_status,
        cuisines: business?.business_menu_types ?? null,
        impersonated_by: req.panel.user_id,
      },
    });
  } catch (err) {
    console.log("MFB-error-logs ~ profile impersonate ~ err:", err);
    res.status(500).json({ message: "Failed to open that account" });
  }
};
