// Web panel API, consumed by MFB-ADMIN-PANEL (React + Vite).
//
// Replaces the CodeIgniter `administration` app. That app was multi-tenant —
// staff, vendors and riders all signed in and were routed to different
// dashboards — so this router has three groups:
//
//   /auth/*    open to everyone who may use the panel
//   /portal/*  vendors and riders, scoped to their own data by the token
//   the rest   admin staff only
const express = require("express");

const {
  verifyPanelToken,
  requireAdmin,
  isAdminRole,
  isVendorRole,
} = require("../middlewares/verifyAdmin");
const auth = require("../controllers/admin/auth");
const dashboard = require("../controllers/admin/dashboard");
const dispatch = require("../controllers/admin/dispatch");
const orders = require("../controllers/admin/orders");
const catalogue = require("../controllers/admin/catalogue");
const people = require("../controllers/admin/people");
const users = require("../controllers/admin/users");
const portal = require("../controllers/admin/portal");
const profile = require("../controllers/admin/profile");
const uploads = require("../controllers/admin/uploads");
const notify = require("../controllers/admin/notify");
const register = require("../controllers/admin/register");
const places = require("../controllers/admin/places");
const menus = require("../controllers/admin/menus");
const settings = require("../controllers/admin/settings");
const deliveryAdmin = require("../controllers/deliveryAdmin");
const panelShifts = require("../controllers/admin/shifts");
const realtime = require("../controllers/admin/realtime");
const adminNotifications = require("../controllers/admin/notifications");
const {
  loginPerAccount,
  loginPerIp,
  passwordChange,
  register: registerLimit,
  otpSendPerPhone,
  otpSendPerIp,
  otpVerify,
} = require("../middlewares/rateLimit");

const router = express.Router();

// /portal/* is shared with riders, who have no catalogue at all. Reading a
// product list they will never fill is harmless, but writing one is not: a rider
// POSTing to /portal/products would create a dish owned by their own account,
// which the storefront would then try to sell. Admin staff keep access — the
// same handlers are theirs at /products.
const requireStore = (req, res, next) => {
  if (isVendorRole(req.panel?.role) || isAdminRole(req.panel?.role)) return next();
  return res.status(403).json({ message: "Only a store can list products" });
};

// ── Public ─────────────────────────────────────────────────────────
//
// Everything in this block is reachable without a token, and every entry is
// rate limited: login and reset-password guard a secret, register and
// forgot-password spend an SMS. See middlewares/rateLimit.js for the counting
// rules — guards count failures only, spends count every call.
//
// Login is the sharpest of these because store_users holds plaintext
// passwords, so a successful guess is the password itself, not a hash to crack.
router.post("/auth/login", loginPerAccount, loginPerIp, auth.login);
// Self-service signup and recovery (administration/Index::Register,
// VerifyOTP, ForgotPassword, ResetPassword).
router.post("/auth/register", registerLimit, otpSendPerPhone, register.register);
router.post("/auth/verify-otp", otpVerify, register.verifyOtp);
// Replies identically whether or not the number exists, so the limiter must
// count every call rather than failures — there are no failures to count.
router.post("/auth/forgot-password", otpSendPerPhone, otpSendPerIp, register.forgotPassword);
// The one that actually takes an account over: a correct 6-digit guess here
// sets a new password. Same bucket as the other OTP checks for this phone.
router.post("/auth/reset-password", otpVerify, register.resetPassword);

// Address lookup for the map picker. Public because a vendor places their
// kitchen on the map during signup, before an account exists. Rate limited per
// IP in the controller — it spends money on every call.
router.get("/places/search", places.search);
router.get("/places/reverse", places.reverse);

// The live event stream. Above verifyPanelToken on purpose: the browser's
// EventSource cannot set an Authorization header, so this one endpoint
// authenticates itself with a short-lived ticket taken from the query string.
// The ticket is minted below, behind the normal guard. See
// controllers/admin/realtime.js for why that trade is acceptable.
router.get("/realtime/stream", realtime.stream);

// ── Signed in (any panel role) ─────────────────────────────────────
router.use(verifyPanelToken);

router.get("/auth/me", auth.me);
router.post("/auth/logout", auth.logout);
// Re-checks the current password, so it is a password oracle for a stolen
// token. Keyed on the account rather than the IP.
router.put("/auth/password", passwordChange, auth.changePassword);

// ── Vendor / rider portals ─────────────────────────────────────────
// Scoping comes from the token inside each handler, so a vendor can only ever
// read their own orders. Admins may call these too and see everything.
router.get("/portal/me", portal.profile);
router.get("/portal/dashboard", portal.dashboard);
router.get("/portal/orders", portal.orders);
// Must precede /portal/orders/:id, or "new"/"pending" are parsed as order ids.
router.get("/portal/orders/new", portal.newOrders);
router.get("/portal/orders/pending", portal.pendingOrders);
router.get("/portal/orders/:id", portal.orderDetail);
router.put("/portal/orders/:id/status", portal.updateStatus);
// Accept and decline are their own verbs rather than a status write: both do
// more than move a number (prep time, refund, customer notification), and a
// vendor must not be able to reach those side effects by PUTting status 6.
router.put("/portal/orders/:id/accept", portal.acceptOrder);
router.put("/portal/orders/:id/decline", portal.declineOrder);
router.put("/portal/orders/:id/payment", portal.riderPayment);
router.get("/portal/reports", portal.reports);
// A rider's own delivery-app shifts, mirroring the partner app. Read-only.
router.get("/portal/shifts", panelShifts.mine);
router.get("/portal/products", portal.vendorProducts);
router.put("/portal/store", portal.toggleOwnStore);

// A vendor's own add / edit / remove screen. These are the admin catalogue
// handlers unchanged, not a vendor fork: each one already scopes itself to the
// caller — create and copy write product_user_id = the token's user, and detail,
// update and delete refuse a product owned by somebody else. Mounting them here
// only opens the door; the rules are the same on both sides of it.
//
// "copy" is a POST on a longer path than "/portal/products", so it is never
// parsed as an id.
router.post("/portal/products", requireStore, catalogue.createProduct);
router.post("/portal/products/copy", requireStore, catalogue.copyProduct);
router.get("/portal/products/:id", catalogue.productDetail);
router.put("/portal/products/:id", requireStore, catalogue.updateProduct);
router.delete("/portal/products/:id", requireStore, catalogue.deleteProduct);

// "Copy Products" — administration/Vendor::Products and Settings::Products.
// A vendor browses everyone's catalogue and clones a dish into their own store.
router.get("/portal/catalogue", catalogue.searchCatalogue);

// A vendor's own menu (store_menu). Cuisines are readable by everyone because
// the category form has to offer them; writing one is refused inside the
// handler for anybody who is not admin staff.
router.get("/portal/menus/cuisines", menus.listCuisines);
router.get("/portal/menus/categories", menus.listCategories);
router.get("/portal/menus/assignable", menus.assignable);
router.post("/portal/menus", menus.create);
router.put("/portal/menus/:id", menus.update);
router.delete("/portal/menus/:id", menus.disable);

// ── Profile (own account; admins may pass an :id) ──────────────────
router.get("/profile", profile.get);
router.put("/profile/basic", profile.updateBasic);
router.put("/profile/business", profile.updateBusiness);

// ── Image upload — the working replacement for Ajax::uploadFiles ────
router.post("/uploads", uploads.upload);
router.delete("/uploads", uploads.remove);
router.put("/uploads/attach", uploads.attach);

// ── Admin staff only ───────────────────────────────────────────────
router.use(requireAdmin);

router.get("/dashboard", dashboard.summary);

// ── Panel notifications + live channel ─────────────────────────────
// Admin staff only: these read store_user_notifications scoped to the signed-in
// admin's own user_id, and mint the stream ticket.
router.get("/realtime/ticket", realtime.ticket);
router.get("/realtime/stats", realtime.stats);
router.get("/notifications", adminNotifications.list);
router.get("/notifications/unread-count", adminNotifications.unreadCount);
router.post("/notifications/read-all", adminNotifications.markAllRead);
router.post("/notifications/:id/read", adminNotifications.markRead);

// ── Delivery dispatch engine ───────────────────────────────────────
// The brief's /dispatch/* surface, under the panel's existing auth.
router.get("/dispatch/status", dispatch.status);
router.get("/dispatch/unassigned", dispatch.unassigned);
router.get("/dispatch/jobs/:id", dispatch.jobDetail);
// Scores the fleet for a job without offering anything — the "why did that
// rider get it?" endpoint.
router.get("/dispatch/jobs/:id/candidates", dispatch.candidates);
router.post("/dispatch/jobs/:id/start", dispatch.start);
router.post("/dispatch/jobs/:id/reassign", dispatch.reassign);
router.post("/dispatch/jobs/:id/cancel", dispatch.cancel);

// Dropdown data every list and report screen needs: riders and vendors.
router.get("/lookups", orders.lookups);

// /reports must precede /:id or "reports" is read as an order id.
router.get("/orders", orders.list);
router.get("/orders/reports", orders.reports);
router.get("/orders/:id", orders.detail);
router.get("/orders/:id/catalogue", orders.orderCatalogue);
router.put("/orders/:id/status", orders.updateStatus);
router.put("/orders/:id/payment", orders.updatePayment);
router.put("/orders/:id/address", orders.updateAddress);
// Invoice editing — Orders::OrderUpdate (qty branch) and InvoiceProductAdd.
router.post("/orders/:id/items", orders.addItem);
router.put("/orders/:id/items/:detailId", orders.updateItem);
router.delete("/orders/:id/items/:detailId", orders.removeItem);

// /search must precede /:id or "search" is read as a product id.
router.get("/products", catalogue.listProducts);
router.get("/products/search", catalogue.searchCatalogue);
router.post("/products", catalogue.createProduct);
router.post("/products/copy", catalogue.copyProduct);
router.get("/products/:id", catalogue.productDetail);
router.put("/products/:id", catalogue.updateProduct);
router.delete("/products/:id", catalogue.deleteProduct);

router.get("/categories", catalogue.listCategories);
router.post("/categories", catalogue.createCategory);
router.put("/categories/:id", catalogue.updateCategory);

// Cuisines and the vendor menu tree (store_menu) — Categories::Index.
router.get("/menus/cuisines", menus.listCuisines);
router.get("/menus/categories", menus.listCategories);
router.get("/menus/assignable", menus.assignable);
router.get("/menus/vendors", menus.vendors);
router.post("/menus", menus.create);
router.put("/menus/:id", menus.update);
router.delete("/menus/:id", menus.disable);

// Banners — Settings::Index.
router.get("/banners", settings.list);
router.post("/banners", settings.create);
router.put("/banners/:id", settings.update);
router.delete("/banners/:id", settings.remove);

// User management. /locations sits above /:id so it isn't read as an id.
router.get("/users/locations", users.locations);
router.post("/users", users.create);
router.put("/users/:id", users.update);
router.put("/users/:id/bank", users.saveBank);

// /detail/:id sits above /:group so it isn't captured as a group name.
// Profile of another user, delivery areas, and impersonation — admin only.
router.get("/profile/:id", profile.get);
router.put("/profile/basic/:id", profile.updateBasic);
router.put("/profile/business/:id", profile.updateBusiness);
router.put("/profile/areas/:id", profile.saveAreas);
router.post("/profile/impersonate/:id", profile.impersonate);

// Notifications — administration/Notifications::orderReceived.
router.post("/notifications/order-received/:orderId", notify.orderReceived);

router.get("/people/detail/:id", people.detail);
router.get("/people/:group", people.list);
// Three independent switches, exactly as the PHP vendors list had:
// user_status (account), user_active (listed), user_login (open now).
router.put("/people/:id/status", people.setStatus);
router.put("/people/:id/active", people.setActive);
router.put("/vendors/:id/store", people.setStoreOpen);

// ── Delivery-partner onboarding review ─────────────────────────────
//
// The same handlers are also mounted at /delivery/admin/* behind the shared
// ADMIN_API_KEY, for scripts and manual approval. The panel cannot use that:
// putting the key in a browser bundle would publish it. So the handlers are
// reused here under the panel's own JWT (verifyPanelToken + requireAdmin),
// which is the auth the panel already holds. One implementation, two doors.
// Shift oversight — must precede /delivery/partners/:id patterns is not an
// issue here, but keep it grouped with the other delivery routes.
router.get("/delivery/shifts", panelShifts.list);
router.get("/delivery/shifts/:id", panelShifts.detail);
router.get("/delivery/sessions", panelShifts.sessions);
router.get("/delivery/partners", deliveryAdmin.listPartners);
router.get("/delivery/partners/:id", deliveryAdmin.getPartner);
router.put("/delivery/partners/:id/verify", deliveryAdmin.verify);
router.get("/delivery/partners/:id/ratings", deliveryAdmin.listRatings);

module.exports = router;
