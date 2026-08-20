const { DeliveryDevice } = require("../models");

// POST /delivery/devices — register (or refresh) an FCM token for this partner.
// Tokens are globally unique: if one was previously registered to another
// partner (shared device, reinstall), it's reassigned to the current partner.
exports.register = async (req, res) => {
  try {
    const dpId = req.user.dp_id;
    const { token, platform } = req.body;
    if (!token) {
      return res.status(400).json({ message: "Missing device token" });
    }

    const existing = await DeliveryDevice.findOne({ where: { token } });
    if (existing) {
      await existing.update({
        dp_id: dpId,
        platform: platform || existing.platform,
        last_seen: new Date(),
      });
    } else {
      await DeliveryDevice.create({
        dp_id: dpId,
        token,
        platform: platform || "android",
        last_seen: new Date(),
      });
    }

    res.json({ message: "Device registered" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery device register ~ err:", err);
    res.status(500).json({ message: "Failed to register device" });
  }
};

// DELETE /delivery/devices — unregister a token (called on logout / opt-out).
exports.unregister = async (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    if (!token) {
      return res.status(400).json({ message: "Missing device token" });
    }
    await DeliveryDevice.destroy({ where: { token, dp_id: req.user.dp_id } });
    res.json({ message: "Device unregistered" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery device unregister ~ err:", err);
    res.status(500).json({ message: "Failed to unregister device" });
  }
};
