// Thin wrapper over the OTPless headless Auth API.
// Both the customer (store_users) and delivery-partner auth flows go through
// here so the OTPless credentials and request/response shape live in one place.

const OTPLESS_BASE_URL = "https://auth.otpless.app/auth/v1";

const CHANNELS = {
  SMS: "SMS",
  WHATSAPP: "WHATSAPP",
};

// Local/dev bypass: when OTP_DEV_MODE=true no OTP is actually sent and any
// login accepts the fixed OTP_DEV_CODE (default "123456"). Never enable this in
// production — it lets anyone log in as any number.
const isDevMode = () => process.env.OTP_DEV_MODE === "true";
const DEV_OTP_CODE = () => process.env.OTP_DEV_CODE || "123456";

// Accepts anything the client sends ("sms", "whatsapp", "WHATSAPP", …) and
// falls back to SMS for unknown values.
const normalizeChannel = (channel) => {
  const value = String(channel || "").trim().toUpperCase();
  return value === CHANNELS.WHATSAPP ? CHANNELS.WHATSAPP : CHANNELS.SMS;
};

const otplessHeaders = () => ({
  clientId: process.env.OTPLESS_CLIENT_ID,
  clientSecret: process.env.OTPLESS_CLIENT_SECRET,
  "Content-Type": "application/json",
});

// Sends an OTP over the chosen channel and returns the OTPless requestId, which
// the caller must persist so it can be replayed during verification.
const initiateOtp = async (phoneNumber, channel = CHANNELS.SMS) => {
  if (isDevMode()) {
    console.log(
      `MFB-dev ~ OTP for +91${phoneNumber} via ${normalizeChannel(
        channel
      )}: use ${DEV_OTP_CODE()}`
    );
    return { requestId: `dev:${phoneNumber}` };
  }

  const response = await fetch(`${OTPLESS_BASE_URL}/initiate/otp`, {
    method: "POST",
    headers: otplessHeaders(),
    body: JSON.stringify({
      phoneNumber: `+91${phoneNumber}`,
      expiry: 600,
      otpLength: 6,
      channels: [normalizeChannel(channel)],
    }),
  });

  const data = await response.json();

  if (!response.ok || !data?.requestId) {
    throw new Error(data?.message || "Failed to initiate OTP");
  }

  return data;
};

// Verifies the OTP the user typed against the stored requestId. Returns a
// simple { verified, data } shape so controllers don't have to know OTPless's
// response field names.
const verifyOtp = async (requestId, otp) => {
  if (isDevMode()) {
    return { verified: String(otp) === DEV_OTP_CODE(), data: { dev: true } };
  }

  const response = await fetch(`${OTPLESS_BASE_URL}/verify/otp`, {
    method: "POST",
    headers: otplessHeaders(),
    body: JSON.stringify({ requestId, otp }),
  });

  const data = await response.json();
  const verified = data?.isOTPVerified === true || data?.isVerified === true;

  return { verified, data };
};

module.exports = {
  CHANNELS,
  normalizeChannel,
  initiateOtp,
  verifyOtp,
};
