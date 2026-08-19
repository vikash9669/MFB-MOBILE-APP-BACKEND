// Auth guard for the web panel (/admin/*).
//
// The PHP panel was multi-tenant: one login, four kinds of user, routed by
// store_users.user_role (administration/Index::loginUser).
//
//   0, 1, 2 = admin staff  → main dashboard
//   3       = rider        → /rider/dashboard   (their own deliveries)
//   4       = vendor       → /vendor/dashboard  (their own store)
//   12      = customer     → refused; customers use the storefront
//
// Only role 0 could manage delivery areas; 1 and 2 were otherwise identical to
// each other and to 0. A commented-out branch in Orders_Model shows role 1 was
// meant to be scoped to its own user_location — that was never enabled.
//
// The CodeIgniter session is replaced by a JWT carrying the role, so the same
// token drives both API authorisation and which portal the SPA renders.
const jwt = require("jsonwebtoken");

const ADMIN_ROLES = [0, 1, 2];
const RIDER_ROLE = 3;
const VENDOR_ROLE = 4;
const CUSTOMER_ROLE = 12;

const isAdminRole = (role) => ADMIN_ROLES.includes(Number(role));
const isVendorRole = (role) => Number(role) === VENDOR_ROLE;
const isRiderRole = (role) => Number(role) === RIDER_ROLE;

/** Everyone the PHP panel let in. Customers were never included. */
const canUsePanel = (role) =>
  isAdminRole(role) || isVendorRole(role) || isRiderRole(role);

const scopeFor = (role) => {
  if (isAdminRole(role)) return "admin";
  if (isVendorRole(role)) return "vendor";
  if (isRiderRole(role)) return "rider";
  return null;
};

// Verifies the bearer token and attaches the payload to req.panel.
function verifyPanelToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ message: "Not signed in" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET_KEY);
    if (payload.scope !== "admin_panel") {
      return res.status(401).json({ message: "Invalid token" });
    }
    req.panel = payload;
    // Kept for the endpoints written before the portals existed.
    req.admin = payload;
    return next();
  } catch {
    return res.status(401).json({ message: "Session expired" });
  }
}

/** Admin-only routes (everything a vendor or rider must not reach). */
function requireAdmin(req, res, next) {
  if (!isAdminRole(req.panel?.role)) {
    return res.status(403).json({ message: "Not permitted" });
  }
  return next();
}

/** Role 0 only — delivery areas, per administration/Profile::Index. */
function requireSuperAdmin(req, res, next) {
  if (Number(req.panel?.role) !== 0) {
    return res.status(403).json({ message: "Only a level-0 admin can do this" });
  }
  return next();
}

function requireVendor(req, res, next) {
  if (!isVendorRole(req.panel?.role)) {
    return res.status(403).json({ message: "Vendors only" });
  }
  return next();
}

function requireRider(req, res, next) {
  if (!isRiderRole(req.panel?.role)) {
    return res.status(403).json({ message: "Riders only" });
  }
  return next();
}

module.exports = {
  verifyPanelToken,
  // Old name, still used by routes/admin.js.
  verifyAdminToken: verifyPanelToken,
  requireAdmin,
  requireSuperAdmin,
  requireVendor,
  requireRider,
  isAdminRole,
  isVendorRole,
  isRiderRole,
  canUsePanel,
  scopeFor,
  ADMIN_ROLES,
  VENDOR_ROLE,
  RIDER_ROLE,
  CUSTOMER_ROLE,
};
