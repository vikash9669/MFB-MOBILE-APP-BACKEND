// Admin panel auth — the React equivalent of administration/Index::loginUser.
//
// Credential handling matches the PHP panel exactly so existing staff logins
// keep working: identifier may be either user_email or user_phone, and the
// password is compared against store_users.user_password.
//
// ⚠️ Those passwords are stored in PLAINTEXT (User_Model::_Login compares them
// with a direct WHERE). We preserve that comparison so nobody is locked out,
// but it should be migrated to bcrypt — see ADMIN_PANEL_MIGRATION.md.
const { Op } = require("sequelize");
const jwt = require("jsonwebtoken");
const { User, Business } = require("../../models");
const { canUsePanel, scopeFor } = require("../../middlewares/verifyAdmin");

const TOKEN_TTL = "12h";

const publicUser = (u, cuisines) => ({
  portal: scopeFor(u.user_role),
  user_id: u.user_id,
  name: u.user_name,
  email: u.user_email,
  phone: u.user_phone,
  role: Number(u.user_role),
  city: u.user_city,
  state: u.user_state,
  image: u.user_image || null,
  status: u.user_status,
  cuisines: cuisines || null,
});

// POST /admin/auth/login  { username, password }
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Enter your username and password" });
    }

    const user = await User.findOne({
      where: {
        [Op.and]: [
          { user_password: String(password) },
          { [Op.or]: [{ user_email: username }, { user_phone: username }] },
        ],
      },
    });

    if (user == null) {
      return res.status(401).json({ message: "Invalid username or password" });
    }
    if (!canUsePanel(user.user_role)) {
      // Mirrors the PHP panel: staff, vendors and riders all sign in here;
      // customers never could — they use the storefront.
      return res.status(403).json({ message: "This account cannot access the panel" });
    }
    if (Number(user.user_status) === 0) {
      return res.status(403).json({ message: "This account is disabled" });
    }

    const business = await Business.findOne({ where: { user_id: user.user_id } });

    const token = jwt.sign(
      {
        scope: "admin_panel",
        // Which portal the SPA should render, and what the API will authorise.
        portal: scopeFor(user.user_role),
        user_id: user.user_id,
        role: Number(user.user_role),
        name: user.user_name,
      },
      process.env.JWT_SECRET_KEY,
      { expiresIn: TOKEN_TTL }
    );

    // The PHP panel stamped user_login on every sign-in; keep the behaviour so
    // any reporting that reads it stays correct.
    await user.update({ user_login: 1, user_last_login: new Date() });

    res.json({ token, user: publicUser(user, business?.business_menu_types) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin login ~ err:", err);
    res.status(500).json({ message: "Login failed" });
  }
};

// GET /admin/auth/me — lets the SPA restore a session on refresh.
exports.me = async (req, res) => {
  try {
    const user = await User.findByPk(req.panel.user_id);
    if (user == null) {
      return res.status(404).json({ message: "Account not found" });
    }
    const business = await Business.findOne({ where: { user_id: user.user_id } });
    res.json({ user: publicUser(user, business?.business_menu_types) });
  } catch (err) {
    console.log("MFB-error-logs ~ admin me ~ err:", err);
    res.status(500).json({ message: "Failed to load profile" });
  }
};

// POST /admin/auth/logout — clears the server-side login flag. The SPA drops
// its token; JWTs are stateless so there is nothing else to revoke.
exports.logout = async (req, res) => {
  try {
    await User.update({ user_login: 0 }, { where: { user_id: req.panel.user_id } });
    res.json({ message: "Signed out" });
  } catch {
    res.json({ message: "Signed out" });
  }
};

// PUT /admin/auth/password  { current_password, new_password }
// Equivalent of administration/Profile::Password.
exports.changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || String(new_password).length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters" });
    }
    const user = await User.findByPk(req.panel.user_id);
    if (user == null || String(user.user_password) !== String(current_password)) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }
    await user.update({ user_password: String(new_password) });
    res.json({ message: "Password updated" });
  } catch (err) {
    console.log("MFB-error-logs ~ admin changePassword ~ err:", err);
    res.status(500).json({ message: "Failed to update password" });
  }
};
