// All authenticated delivery-partner APIs, mounted under /delivery.
// Every route requires a valid partner access token (verifyToken) and the
// delivery_partner role (requirePartner). Public auth routes live separately
// in routes/deliveryAuth.js (mounted at /delivery/auth).
const express = require("express");

const { verifyToken, requirePartner } = require("../middlewares/verifyToken");
const { requireApproved } = require("../middlewares/deliveryGuards");
const { deliveryCode } = require("../middlewares/rateLimit");
const profile = require("../controllers/deliveryProfile");
const onboarding = require("../controllers/deliveryOnboarding");
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

// ── Onboarding / KYC verification (open to unverified partners) ─────
router.get("/onboarding", onboarding.getStatus);
router.post("/onboarding/submit", onboarding.submit);

// ── Home / live status ─────────────────────────────────────────────
router.get("/home/summary", status.getSummary);
// Going online requires an approved account.
router.post("/status/online", requireApproved, status.setOnline);
router.post("/status/location", status.updateLocation);

// ── Orders (the delivery flow) ─────────────────────────────────────
router.get("/orders/incoming", orders.getIncoming);
router.get("/orders/active", orders.getActive);
router.get("/orders/history", orders.getHistory);
router.get("/orders/:id", orders.getOne);
// Road route for one leg, so the map draws streets instead of a straight line.
router.get("/orders/:id/route", orders.getRoute);
router.post("/orders/:id/accept", requireApproved, orders.accept);
router.post("/orders/:id/reject", orders.reject);
// Doorstep online collection for a COD order: show a QR, then poll for the
// money. The rider never marks it paid themselves.
router.post("/orders/:id/collect", requireApproved, orders.startCollect);
router.get("/orders/:id/collect", orders.collectStatus);
// Both check a code the rider is not supposed to know, so both are capped on
// wrong answers — keyed on the partner, so one rider guessing never blocks
// another rider's real delivery. The risk is not an outsider: it is a rider
// brute-forcing the customer's door code to mark an order delivered without
// handing the food over, which pays them and closes the job.
router.post("/orders/:id/verify-pickup", deliveryCode, orders.verifyPickup);
router.post("/orders/:id/verify-delivery", deliveryCode, orders.verifyDelivery);
router.post("/orders/:id/report-issue", orders.reportIssue);

// ── Earnings ───────────────────────────────────────────────────────
router.get("/earnings", earnings.getEarnings);

// ── Wallet ─────────────────────────────────────────────────────────
router.get("/wallet", wallet.getWallet);
router.post("/wallet/withdraw", wallet.withdraw);

// ── Shifts ─────────────────────────────────────────────────────────
router.get("/shifts", shifts.getShifts);
// A partner declaring their own availability, and dropping it again.
router.post("/shifts", shifts.create);
router.get("/shifts/:id", shifts.detail);
router.delete("/shifts/:id", shifts.remove);
router.post("/shifts/:id/book", shifts.book);
router.post("/shifts/:id/extend", shifts.extend);

// ── Performance ────────────────────────────────────────────────────
router.get("/performance", performance.getPerformance);

// ── Documents / KYC ────────────────────────────────────────────────
router.get("/documents", documents.getDocuments);
router.post("/documents", documents.upsert);
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
