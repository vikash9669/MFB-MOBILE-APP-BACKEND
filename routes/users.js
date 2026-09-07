const express = require("express");
const orderController = require("../controllers/order");
const userController = require("../controllers/user");
const authController = require("../controllers/auth");
const notifications = require("../controllers/customerNotifications");
const paymentController = require("../controllers/payment");
const { paymentInitiate, paymentConfirm } = require("../middlewares/rateLimit");
const { verifyToken } = require("../middlewares/verifyToken");
const storefront = require("../controllers/storefront");
const riderRating = require("../controllers/riderRating");

const router = express.Router();

router.get("/", verifyToken, userController.getUser);

router.post("/", verifyToken, authController.updateUser);

router.get("/cashback", verifyToken, storefront.getCashback);
router.get("/orders", verifyToken, orderController.getOrdersByCustomerId);

router.post("/create-order", verifyToken, orderController.createOrder);

// The offers panel on the checkout screen. Authenticated, so per-user usage
// limits are enforced and a code the customer has already spent is never
// advertised to them — the public /coupon preview cannot do that.
router.post("/coupons/available", verifyToken, orderController.getAvailableCoupons);

router.get("/active-orders", verifyToken, orderController.getActiveOrders);

// The line drawn on the customer's tracking map. Authorised by order
// ownership — see the note on getOrderRoute for why this is not the rider's
// /delivery/orders/:id/route.
router.get("/orders/:id/route", verifyToken, orderController.getOrderRoute);

// Rating the delivery partner. Guarded by the caller owning the order — see
// controllers/riderRating.js, where the checks are and why they matter.
router.get("/orders/:orderId/rate", verifyToken, riderRating.get);
router.post("/orders/:orderId/rate", verifyToken, riderRating.rate);

// ── Online payment ──────────────────────────────────────────────────
// Provider is chosen in util/gateway.js (PAYMENT_PROVIDER; cashfree in
// production), never here — these routes are the same for every gateway.
// initiate → app runs the SDK → confirm. The order row is created inside
// confirm (or the callback), never before the money is verified.
router.post("/payment/initiate", verifyToken, paymentInitiate, paymentController.initiatePayment);
router.post("/payment/confirm", verifyToken, paymentConfirm, paymentController.confirmPayment);

// ── Notifications (in-app centre + unread badge) ────────────────────
router.get("/notifications", verifyToken, notifications.list);
router.get("/notifications/unread-count", verifyToken, notifications.unreadCount);
router.post("/notifications/read-all", verifyToken, notifications.markAllRead);
router.post("/notifications/:id/read", verifyToken, notifications.markRead);

// ── Push devices (FCM token registration) ───────────────────────────
router.post("/devices", verifyToken, notifications.registerDevice);
router.delete("/devices", verifyToken, notifications.unregisterDevice);

module.exports = router;
