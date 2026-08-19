// Admin review endpoints for delivery onboarding, mounted at /delivery/admin.
// Guarded by a shared ADMIN_API_KEY (header x-admin-key) — NOT partner tokens.
// Mounted before the partner router so it isn't captured by verifyToken.
const express = require("express");

const { requireAdmin } = require("../middlewares/deliveryGuards");
const admin = require("../controllers/deliveryAdmin");

const router = express.Router();

router.use(requireAdmin);

router.get("/partners", admin.listPartners);
router.get("/partners/:id", admin.getPartner);
router.put("/partners/:id/verify", admin.verify);

module.exports = router;
