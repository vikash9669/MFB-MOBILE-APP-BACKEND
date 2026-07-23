const DeliveryPartner = require("../models/delivery_partner");
const { generateUserCode } = require("../util/user");
const { initiateOtp, verifyOtp } = require("../util/otpless");
const { maybeProvisionOnLogin } = require("../util/deliveryDemo");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../util/token");

const DEFAULT_SETTINGS = {
  notifications: false,
  location: false,
  camera: false,
  phone: false,
  battery: false,
};

// Builds the access-token payload (also returned to the client as `partner`).
const partnerClaims = (partner) => ({
  dp_id: partner.dp_id,
  dp_name: partner.dp_name,
  dp_email: partner.dp_email,
  dp_phone: partner.dp_phone,
  role: "delivery_partner",
  settings: partner.dp_settings || DEFAULT_SETTINGS,
});

// Issues a fresh access + refresh token pair for a partner. The refresh token
// carries the current token version so it can be invalidated on logout.
const issueTokens = (partner) => {
  const claims = partnerClaims(partner);
  return {
    accessToken: signAccessToken(claims),
    refreshToken: signRefreshToken({
      dp_id: partner.dp_id,
      tokenVersion: partner.dp_token_version,
    }),
    partner: claims,
  };
};

// Sends the OTP via OTPless and stores the returned requestId on the partner
// row so verify can replay it. Creates the partner on first login.
const sendOtp = async (phoneNumber, channel) => {
  const data = await initiateOtp(phoneNumber, channel);

  const [partner] = await DeliveryPartner.findOrCreate({
    where: { dp_phone: phoneNumber },
    defaults: {
      dp_phone: phoneNumber,
      dp_name: "",
      dp_email: "",
      dp_code: generateUserCode(12),
      dp_request_id: data.requestId,
      dp_settings: DEFAULT_SETTINGS,
    },
  });

  await partner.update({ dp_request_id: data.requestId });

  return data;
};

exports.getOtp = async (req, res) => {
  try {
    const { phone_number, channel } = req.body;
    await sendOtp(phone_number, channel);
    res.json({ message: "OTP sent successfully" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getOtp ~ err:", err);
    res.status(500).json({ message: "Otp sending failed", err });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { phone_number, user_otp } = req.body;
    const partner = await DeliveryPartner.findOne({
      where: { dp_phone: phone_number },
    });

    if (partner == null || !partner.dp_request_id) {
      res.status(400).json({ message: "Please request an OTP first" });
      return;
    }

    const { verified } = await verifyOtp(partner.dp_request_id, user_otp);
    if (!verified) {
      res.status(401).json({ message: "Invalid or expired OTP" });
      return;
    }

    await partner.update({ dp_last_login: new Date() });

    // Seed demo data on first login so the app has content to show (dev only,
    // idempotent — skipped once the partner already has data).
    await maybeProvisionOnLogin(partner);

    res.json({ message: "OTP verified successfully", ...issueTokens(partner) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery verifyOtp ~ err:", err);
    res.status(500).json({ message: "Otp verification failed", err });
  }
};

exports.refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ message: "Missing refresh token" });
      return;
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      res.status(401).json({ message: "Invalid or expired refresh token" });
      return;
    }

    if (decoded.type !== "refresh") {
      res.status(401).json({ message: "Invalid refresh token" });
      return;
    }

    const partner = await DeliveryPartner.findByPk(decoded.dp_id);
    // A version mismatch means the token was revoked (partner logged out).
    if (partner == null || partner.dp_token_version !== decoded.tokenVersion) {
      res.status(401).json({ message: "Refresh token revoked" });
      return;
    }

    res.json({ message: "Token refreshed", ...issueTokens(partner) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery refresh ~ err:", err);
    res.status(500).json({ message: "Token refresh failed", err });
  }
};

// Requires verifyToken middleware (access token) → req.user.dp_id.
exports.logout = async (req, res) => {
  try {
    const { dp_id } = req.user;
    // Invalidate every outstanding refresh token for this partner.
    await DeliveryPartner.increment("dp_token_version", { where: { dp_id } });
    res.json({ message: "Logged out" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery logout ~ err:", err);
    res.status(500).json({ message: "Logout failed", err });
  }
};

// Requires verifyToken middleware. Merges the posted settings and returns them
// plus a fresh access token embedding the updated snapshot.
exports.updateSettings = async (req, res) => {
  try {
    const { dp_id } = req.user;
    const { settings } = req.body;

    const partner = await DeliveryPartner.findByPk(dp_id);
    if (partner == null) {
      res.status(404).json({ message: "Partner not found" });
      return;
    }

    const merged = { ...(partner.dp_settings || DEFAULT_SETTINGS), ...(settings || {}) };
    await partner.update({ dp_settings: merged });

    res.json({
      message: "Settings updated",
      settings: merged,
      accessToken: signAccessToken(partnerClaims(partner)),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery updateSettings ~ err:", err);
    res.status(500).json({ message: "Settings update failed", err });
  }
};
