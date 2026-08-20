// Guards specific to the delivery-partner APIs.
const DeliveryPartner = require("../models/delivery_partner");
const { adminKey } = require("./rateLimit");

// requireAdmin — protects the admin review endpoints. A simple shared-secret
// check (header `x-admin-key` must equal ADMIN_API_KEY). Good enough for the
// internal/manual approval flow; swap for a real admin auth when a dashboard
// exists. Fails closed if ADMIN_API_KEY isn't configured.
//
// One shared secret, compared as a string, with no account behind it to lock
// out — so guessing is only expensive if we make it expensive. The rate limiter
// is bundled into the export rather than added at each mount point, because
// this guard protects two routers (/delivery/admin/* and /notify/push) and a
// third one added later would otherwise ship unlimited by default.
const checkAdminKey = (req, res, next) => {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return res
      .status(503)
      .json({ message: "Admin API not configured — set ADMIN_API_KEY in .env" });
  }
  const provided = req.headers["x-admin-key"];
  if (!provided || provided !== expected) {
    return res.status(401).json({ message: "Admin access denied" });
  }
  next();
};

// Express flattens an array of handlers, so every existing
// `router.use(requireAdmin)` and `router.post(..., requireAdmin, ...)` call site
// picks up the limiter without changing.
exports.requireAdmin = [adminKey, checkAdminKey];

// requireApproved — defence-in-depth for operational endpoints (go online,
// accept order). The app already hides these behind the onboarding gate, but
// this blocks an unverified partner from reaching them via the API directly.
// Reads the live status from the DB (not the token, which can be stale).
exports.requireApproved = async (req, res, next) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id, {
      attributes: ["dp_verification_status"],
    });
    if (!partner || partner.dp_verification_status !== "approved") {
      return res.status(403).json({
        message: "Your account is not verified yet",
        verification_status: partner ? partner.dp_verification_status : "pending",
      });
    }
    next();
  } catch (err) {
    console.log("MFB-error-logs ~ requireApproved ~ err:", err);
    return res.status(500).json({ message: "Verification check failed" });
  }
};
