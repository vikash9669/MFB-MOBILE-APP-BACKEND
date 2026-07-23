const { DeliveryPartner } = require("../models");
const { serializePartner } = require("../util/delivery");

// GET /delivery/me — the signed-in partner's full profile (Profile screen).
exports.getMe = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }
    res.json({ partner: serializePartner(partner) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getMe ~ err:", err);
    res.status(500).json({ message: "Failed to load profile", err });
  }
};

// PUT /delivery/me — update editable profile fields (name, email, vehicle).
exports.updateMe = async (req, res) => {
  try {
    const partner = await DeliveryPartner.findByPk(req.user.dp_id);
    if (partner == null) {
      return res.status(404).json({ message: "Partner not found" });
    }

    const { name, email, vehicle_type, vehicle_number } = req.body;
    const patch = {};
    if (name != null) patch.dp_name = name;
    if (email != null) patch.dp_email = email;
    if (vehicle_type != null) patch.dp_vehicle_type = vehicle_type;
    if (vehicle_number != null) patch.dp_vehicle_number = vehicle_number;

    await partner.update(patch);
    res.json({ message: "Profile updated", partner: serializePartner(partner) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery updateMe ~ err:", err);
    res.status(500).json({ message: "Failed to update profile", err });
  }
};
