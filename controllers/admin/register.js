// Self-registration and password recovery — administration/Index::Register,
// VerifyOTP/validOTP, ForgotPassword and ResetPassword.
//
// Rules kept from the PHP form validation:
//   • phone: numeric, exactly 10 digits, unique in store_users
//   • password: 8–16 characters
//   • role: chosen at signup ("joining as") — rider or vendor only
//   • terms must be accepted
//   • a 6-digit OTP is texted and must be confirmed before the account activates
//
// Passwords are md5 digests, matching the PHP panel. _Login does compare the
// column directly, but Index::Index has already replaced the submitted password
// with md5($password) before calling it — reading the model alone suggests a
// plaintext comparison that does not exist. See util/password.js.
const jwt = require("jsonwebtoken");
const { User, Business } = require("../../models");
const { initiateOtp, verifyOtp } = require("../../util/otp");
const { parsePin, writePin } = require("../../util/vendorColumns");
const { RIDER_ROLE, VENDOR_ROLE, scopeFor } = require("../../middlewares/verifyAdmin");
const passwords = require("../../util/password");

// The PHP dropdown offered exactly these. Admin accounts are made by an admin.
const SELF_SIGNUP_ROLES = [RIDER_ROLE, VENDOR_ROLE];

const isPhone = (v) => /^\d{10}$/.test(String(v || ""));
const isPassword = (v) => String(v || "").length >= 8 && String(v || "").length <= 16;

// OTPs go through util/otp.js — the same provider the mobile apps use, which
// honours OTP_DEV_MODE and OTP_DEV_NUMBERS so dev numbers never hit a real SMS
// gateway. The PHP panel rolled its own code into store_users.user_otp and
// texted it directly; that cannot work here, because Twilio Verify and MSG91
// generate and hold the code themselves. Verification therefore asks the
// provider rather than comparing a column.
//
// NOTE: OTPless keys verification off a requestId. store_users.user_otp is
// varchar(6) and cannot hold one, so on OTPless this flow would need a column
// to persist it (the delivery partner table has dp_request_id for exactly
// this). Twilio and MSG91 both key off the phone number and work as-is.
async function startOtp(phone) {
  try {
    const data = await initiateOtp(phone, "SMS");
    return { ok: true, requestId: data?.requestId ?? null };
  } catch (err) {
    console.log("MFB-error-logs ~ register otp ~ err:", err.message);
    return { ok: false };
  }
}

async function checkOtp(phone, otp) {
  try {
    const { verified } = await verifyOtp(phone, null, otp);
    return verified === true;
  } catch (err) {
    console.log("MFB-error-logs ~ verify otp ~ err:", err.message);
    return false;
  }
}

// POST /admin/auth/register
exports.register = async (req, res) => {
  try {
    const { name, phone, password, confirm_password, role, agree, business_name } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Enter your name" });
    }
    if (!isPhone(phone)) {
      return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
    }
    if (!isPassword(password)) {
      return res.status(400).json({ message: "Password must be 8 to 16 characters" });
    }
    if (confirm_password !== undefined && confirm_password !== password) {
      return res.status(400).json({ message: "Passwords do not match" });
    }
    if (!SELF_SIGNUP_ROLES.includes(Number(role))) {
      return res.status(400).json({ message: "Choose whether you're joining as a rider or a vendor" });
    }
    if (!agree) {
      return res.status(400).json({ message: "You must accept the terms and conditions" });
    }

    const existing = await User.findOne({ where: { user_phone: String(phone) } });
    if (existing) {
      return res.status(409).json({
        message: "This phone number is already registered. Please sign in instead.",
      });
    }

    const created = await User.create({
      user_role: Number(role),
      user_name: String(name).trim(),
      user_email: req.body.email || `user${Date.now()}@example.com`,
      user_phone: String(phone),
      user_phone_1: String(phone),
      // The provider owns the code; this column stays as a placeholder.
      user_otp: "000000",
      user_code: `U${Date.now().toString().slice(-8)}`,
      user_manager: 0,
      user_landmark: "",
      user_city: "1",
      user_state: 1,
      user_zip: "000000",
      user_location: 0,
      user_password: passwords.hash(password),
      user_registered: new Date(),
      user_login: 0,
      user_active: 1,
      // Not verified until the OTP is confirmed.
      user_status: 0,
    });

    if (Number(role) === VENDOR_ROLE) {
      await Business.create({
        user_id: created.user_id,
        business_name: business_name || String(name).trim(),
        business_order: 0,
        business_slug: `${String(name).trim().replace(/\s+/g, "-")}-${created.user_id}`,
        business_menu_types: "",
        business_type: 0,
        // Closed until an admin reviews and opens it.
        business_status: 0,
        business_discount: 0,
        business_commision: 15,
        business_rain_charges: 0,
      });

      // Where the kitchen is. Asked for at signup because this is the one
      // moment the person filling the form is standing in the place being
      // described — an admin correcting it later is guessing from an address
      // line. Optional: a vendor who skips it still gets an account, and
      // dispatch geocodes the address text as it always did.
      //
      // Written separately from User.create for the reason in
      // util/vendorColumns.js: the pin columns are off the model, so a database
      // without the migration must still be able to register a vendor.
      const pin = parsePin(req.body);
      if (pin) await writePin(created.user_id, pin);
    }

    const { ok: texted } = await startOtp(String(phone));

    res.status(201).json({
      message: texted
        ? `An OTP has been sent to ${phone}. Enter it to finish signing up.`
        : `Account created. We couldn't send the OTP by SMS — contact support to verify.`,
      user_id: created.user_id,
      phone: String(phone),
      otp_sent: texted,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ register ~ err:", err);
    res.status(500).json({ message: "Registration failed" });
  }
};

// POST /admin/auth/verify-otp  { phone, otp } — Index::VerifyOTP + validOTP.
// On success the account is activated and a panel token is issued, so signup
// flows straight into the portal.
exports.verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!isPhone(phone) || !/^\d{6}$/.test(String(otp || ""))) {
      return res.status(400).json({ message: "Enter the 6-digit code" });
    }

    const user = await User.findOne({ where: { user_phone: String(phone) } });
    if (user == null) {
      return res.status(404).json({ message: "No account for that number" });
    }
    if (!(await checkOtp(String(phone), otp))) {
      return res.status(401).json({ message: "Please provide a valid OTP" });
    }

    await user.update({ user_status: 1, user_login: 1, user_last_login: new Date() });

    const token = jwt.sign(
      {
        scope: "admin_panel",
        portal: scopeFor(user.user_role),
        user_id: user.user_id,
        role: Number(user.user_role),
        name: user.user_name,
      },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "12h" }
    );

    res.json({
      message: "Verified",
      token,
      user: {
        portal: scopeFor(user.user_role),
        user_id: user.user_id,
        name: user.user_name,
        email: user.user_email,
        phone: user.user_phone,
        role: Number(user.user_role),
        city: user.user_city,
        state: user.user_state,
        image: user.user_image,
        status: 1,
        cuisines: null,
      },
    });
  } catch (err) {
    console.log("MFB-error-logs ~ verifyOtp ~ err:", err);
    res.status(500).json({ message: "Verification failed" });
  }
};

// POST /admin/auth/forgot-password  { phone } — Index::ForgotPassword.
exports.forgotPassword = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!isPhone(phone)) {
      return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
    }

    const user = await User.findOne({ where: { user_phone: String(phone) } });
    // Deliberately the same reply either way: telling a caller which numbers
    // exist would let them enumerate accounts.
    const reply = {
      message: `If that number has an account, an OTP has been sent to ${phone}. Enter the 6-digit code to reset your password.`,
    };
    if (user == null) return res.json(reply);

    await startOtp(String(phone));
    res.json(reply);
  } catch (err) {
    console.log("MFB-error-logs ~ forgotPassword ~ err:", err);
    res.status(500).json({ message: "Could not start password reset" });
  }
};

// POST /admin/auth/reset-password  { phone, otp, password, confirm_password }
// Index::ResetPassword — verify the OTP, then set the new password.
exports.resetPassword = async (req, res) => {
  try {
    const { phone, otp, password, confirm_password } = req.body;
    if (!isPhone(phone)) {
      return res.status(400).json({ message: "Enter a valid 10-digit phone number" });
    }
    if (!/^\d{6}$/.test(String(otp || ""))) {
      return res.status(400).json({ message: "Enter the 6-digit OTP" });
    }
    if (!isPassword(password)) {
      return res.status(400).json({ message: "Password must be 8 to 16 characters" });
    }
    if (confirm_password !== undefined && confirm_password !== password) {
      return res.status(400).json({ message: "Passwords do not match" });
    }

    const user = await User.findOne({ where: { user_phone: String(phone) } });
    if (user == null || !(await checkOtp(String(phone), otp))) {
      return res.status(401).json({ message: "Please provide a valid OTP" });
    }

    // Plaintext, matching what login reads. The PHP wrote md5 here and broke
    // the account — see the header comment.
    await user.update({ user_password: passwords.hash(password) });

    res.json({ message: "Password updated. You can sign in now." });
  } catch (err) {
    console.log("MFB-error-logs ~ resetPassword ~ err:", err);
    res.status(500).json({ message: "Could not reset password" });
  }
};
