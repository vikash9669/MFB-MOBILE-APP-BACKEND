// Internal push endpoint, mounted at /notify. Lets a trusted system (the
// external order/admin backend) send a customer a notification when an order's
// status changes. Guarded by ADMIN_API_KEY (header x-admin-key) — not a
// customer token — so it isn't callable from the app.
const express = require("express");

const { requireAdmin } = require("../middlewares/deliveryGuards");
const notifications = require("../controllers/customerNotifications");

const router = express.Router();

router.post("/push", requireAdmin, notifications.adminPush);

module.exports = router;
