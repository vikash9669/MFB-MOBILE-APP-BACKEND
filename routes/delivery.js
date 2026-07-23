// All authenticated delivery-partner APIs, mounted under /delivery.
// Every route requires a valid partner access token (verifyToken) and the
// delivery_partner role (requirePartner). Public auth routes live separately
// in routes/deliveryAuth.js (mounted at /delivery/auth).
const express = require("express");

const { verifyToken, requirePartner } = require("../middlewares/verifyToken");
const profile = require("../controllers/deliveryProfile");
const status = require("../controllers/deliveryStatus");
const orders = require("../controllers/deliveryOrders");
const earnings = require("../controllers/deliveryEarnings");
const wallet = require("../controllers/deliveryWallet");
const shifts = require("../controllers/deliveryShifts");
const performance = require("../controllers/deliveryPerformance");
const documents = require("../controllers/deliveryDocuments");
const notifications = require("../controllers/deliveryNotifications");
const devices = require("../controllers/deliveryDevices");

const router = express.Router();

// Apply auth + role guard to every route in this router.
router.use(verifyToken, requirePartner);

// ── Profile ────────────────────────────────────────────────────────
router.get("/me", profile.getMe);
router.put("/me", profile.updateMe);

// ── Home / live status ─────────────────────────────────────────────
router.get("/home/summary", status.getSummary);
router.post("/status/online", status.setOnline);
router.post("/status/location", status.updateLocation);

// ── Orders (the delivery flow) ─────────────────────────────────────
router.get("/orders/incoming", orders.getIncoming);
router.get("/orders/active", orders.getActive);
router.get("/orders/history", orders.getHistory);
router.get("/orders/:id", orders.getOne);
router.post("/orders/:id/accept", orders.accept);
router.post("/orders/:id/reject", orders.reject);
router.post("/orders/:id/verify-pickup", orders.verifyPickup);
router.post("/orders/:id/verify-delivery", orders.verifyDelivery);

// ── Earnings ───────────────────────────────────────────────────────
router.get("/earnings", earnings.getEarnings);

// ── Wallet ─────────────────────────────────────────────────────────
router.get("/wallet", wallet.getWallet);
router.post("/wallet/withdraw", wallet.withdraw);

// ── Shifts ─────────────────────────────────────────────────────────
router.get("/shifts", shifts.getShifts);
router.post("/shifts/:id/book", shifts.book);

// ── Performance ────────────────────────────────────────────────────
router.get("/performance", performance.getPerformance);

// ── Documents / KYC ────────────────────────────────────────────────
router.get("/documents", documents.getDocuments);
router.post("/documents/:id/reupload", documents.reupload);

// ── Notifications ──────────────────────────────────────────────────
router.get("/notifications", notifications.list);
router.get("/notifications/unread-count", notifications.unreadCount);
router.post("/notifications/read-all", notifications.markAllRead);
router.post("/notifications/:id/read", notifications.markRead);

// ── Push devices (FCM token registration) ──────────────────────────
router.post("/devices", devices.register);
router.delete("/devices", devices.unregister);

module.exports = router;
