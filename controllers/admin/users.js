// Creating and editing users — administration/Users::Index($action='create')
// and the Ajax helpers behind it.
//
// The PHP form let an admin create riders (role 3) and vendors (role 4); staff
// accounts were made directly in the database. Staff creation is included here
// because leaving it out is what forced a SQL script to bootstrap the panel.
const { Op } = require("sequelize");
const { User, Business, UserBank, Location } = require("../../models");
// Map pins live on store_users but deliberately not on the User model — see
// util/vendorColumns.js for why naming them there would break sign-in on any
// database that has not run 2026-08-18-vendor-geo.sql.
const { parsePin, writePin, readPin } = require("../../util/vendorColumns");
const {
  ADMIN_ROLES,
  VENDOR_ROLE,
  RIDER_ROLE,
  CUSTOMER_ROLE,
} = require("../../middlewares/verifyAdmin");

// Customers are included because administration/Users::Customers had a `create`
// action too — staff took phone orders from people who had never opened the app.
const CREATABLE_ROLES = [...ADMIN_ROLES, RIDER_ROLE, VENDOR_ROLE, CUSTOMER_ROLE];
const num = (v) => Number(v || 0);

// store_users has several NOT NULL columns with no default (user_location is
// the one that silently broke customer signup), so every insert must supply
// them. These are the safe blanks.
const REQUIRED_BLANKS = {
  user_otp: "000000",
  user_manager: 0,
  user_landmark: "",
  user_zip: "000000",
  user_location: 0,
  user_login: 0,
  user_active: 1,
};

// POST /admin/users
exports.create = async (req, res) => {
  try {
    const { name, phone, email, password, role, address, city, state } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ message: "Name, phone and password are required" });
    }
    if (!CREATABLE_ROLES.includes(Number(role))) {
      return res.status(400).json({ message: "Choose a valid role" });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const clash = await User.findOne({ where: { user_phone: String(phone) } });
    if (clash) {
      return res.status(409).json({
        message: `That number already belongs to user #${clash.user_id}`,
      });
    }

    const created = await User.create({
      ...REQUIRED_BLANKS,
      user_role: Number(role),
      user_name: String(name),
      user_email: email ? String(email) : `user${Date.now()}@example.com`,
      user_phone: String(phone),
      user_phone_1: String(phone),
      user_code: `U${Date.now().toString().slice(-8)}`,
      user_address: address ? String(address) : null,
      user_city: city != null ? String(city) : "1",
      user_state: num(state) || 1,
      // Plaintext, matching the existing scheme — see ADMIN_PANEL_MIGRATION.md.
      user_password: String(password),
      user_registered: new Date(),
      user_status: 1,
    });

    // A vendor is only usable once it has a business row; the storefront and
    // the order pipeline both read business_name from it.
    if (Number(role) === VENDOR_ROLE) {
      await Business.create({
        user_id: created.user_id,
        business_name: req.body.business_name || String(name),
        business_order: 0,
        business_slug: `${String(name).trim().replace(/\s+/g, "-")}-${created.user_id}`,
        business_menu_types: req.body.menu_types || "",
        business_type: 0,
        business_status: 0,
        business_discount: num(req.body.discount),
        business_commision: req.body.commission == null ? 15 : num(req.body.commission),
        business_rain_charges: 0,
      });
    }

    // The kitchen's position on the map, when the form sent one. Written after
    // the row exists rather than as part of the INSERT, because the columns are
    // off the model and may not exist at all — a missing pin must not cost the
    // account. `pin_saved` is reported so the panel can tell an operator their
    // marker was dropped but not kept, instead of silently losing it.
    const pin = parsePin(req.body);
    const pinResult = pin ? await writePin(created.user_id, pin) : null;

    res.status(201).json({
      message: "User created",
      user_id: created.user_id,
      pin_saved: pinResult == null ? null : pinResult.saved,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin create user ~ err:", err);
    res.status(500).json({ message: "Failed to create user" });
  }
};

// PUT /admin/users/:id
exports.update = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (user == null) {
      return res.status(404).json({ message: "User not found" });
    }

    const patch = {};
    if (req.body.name !== undefined) patch.user_name = String(req.body.name);
    if (req.body.email !== undefined) patch.user_email = String(req.body.email);
    if (req.body.address !== undefined) patch.user_address = req.body.address;
    if (req.body.city !== undefined) patch.user_city = String(req.body.city);
    if (req.body.status !== undefined) patch.user_status = Number(req.body.status) ? 1 : 0;

    if (req.body.password) {
      if (String(req.body.password).length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      patch.user_password = String(req.body.password);
    }

    if (req.body.role !== undefined) {
      if (!CREATABLE_ROLES.includes(Number(req.body.role))) {
        return res.status(400).json({ message: "Choose a valid role" });
      }
      // Guard against an admin removing their own access and locking the panel.
      if (user.user_id === req.panel.user_id && !ADMIN_ROLES.includes(Number(req.body.role))) {
        return res.status(400).json({ message: "You cannot remove your own admin access" });
      }
      patch.user_role = Number(req.body.role);
    }

    if (req.body.phone !== undefined && String(req.body.phone) !== user.user_phone) {
      const clash = await User.findOne({
        where: { user_phone: String(req.body.phone), user_id: { [Op.ne]: user.user_id } },
      });
      if (clash) {
        return res.status(409).json({ message: "That number is already in use" });
      }
      patch.user_phone = String(req.body.phone);
      patch.user_phone_1 = String(req.body.phone);
    }

    await user.update(patch);

    // Vendor-only business fields, when supplied.
    if (Number(user.user_role) === VENDOR_ROLE) {
      const business = await Business.findOne({ where: { user_id: user.user_id } });
      if (business) {
        const bpatch = {};
        if (req.body.business_name !== undefined) bpatch.business_name = req.body.business_name;
        if (req.body.commission !== undefined) bpatch.business_commision = num(req.body.commission);
        if (req.body.discount !== undefined) bpatch.business_discount = num(req.body.discount);
        if (req.body.open !== undefined) bpatch.business_open = req.body.open;
        if (req.body.close !== undefined) bpatch.business_close = req.body.close;
        if (Object.keys(bpatch).length) await business.update(bpatch);
      }
    }

    // The map pin, when the request says anything about it.
    //
    // Silence leaves the existing pin alone — most edits are a phone number or
    // a commission rate and must not wipe a kitchen's location. Clearing is
    // therefore explicit: `clear_pin: true` is the only way back to no pin, so
    // an admin can remove a wrong marker and let dispatch geocode again.
    let pinSaved = null;
    if (req.body.clear_pin === true) {
      pinSaved = (await writePin(user.user_id, null)).saved;
    } else {
      const pin = parsePin(req.body);
      if (pin) pinSaved = (await writePin(user.user_id, pin)).saved;
    }

    res.json({ message: "User updated", pin_saved: pinSaved });
  } catch (err) {
    console.log("MFB-error-logs ~ admin update user ~ err:", err);
    res.status(500).json({ message: "Failed to update user" });
  }
};

// PUT /admin/users/:id/bank — the bank tab on the vendor/rider forms.
exports.saveBank = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (user == null) {
      return res.status(404).json({ message: "User not found" });
    }
    const fields = {
      user_id: user.user_id,
      bank_name: req.body.bank_name ?? null,
      bank_account_name: req.body.account_name ?? "",
      bank_account: req.body.account ?? null,
      bank_ifsc: req.body.ifsc ?? null,
      bank_status: Number(req.body.status) ? 1 : 0,
    };
    const existing = await UserBank.findOne({ where: { user_id: user.user_id } });
    if (existing) await existing.update(fields);
    else await UserBank.create(fields);
    res.json({ message: "Bank details saved" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin save bank ~ err:", err);
    res.status(500).json({ message: "Failed to save bank details" });
  }
};

// GET /admin/users/locations — Ajax::Cities / Ajax::States equivalent.
exports.locations = async (req, res) => {
  try {
    const rows = await Location.findAll({ order: [["location_name", "ASC"]], raw: true });
    res.json({
      locations: rows.map((l) => ({
        location_id: l.location_id,
        name: l.location_name,
        parent_id: l.location_parent_id,
        pincode: l.location_pincode,
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ admin locations ~ err:", err);
    res.status(500).json({ message: "Failed to load locations" });
  }
};
