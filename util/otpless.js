// Thin wrapper over the OTPless headless Auth API.
// Selected when MSGPROVIDER=otpless (the default). Both the customer
// (store_users) and delivery-partner flows reach it through util/otp.js, so the
// OTPless credentials and request/response shape live in one place. Dev-mode
// bypass is handled centrally in util/otp.js — this module only speaks OTPless.

const OTPLESS_BASE_URL = "https://auth.otpless.app/auth/v1";

const CHANNELS = {
  SMS: "SMS",
  WHATSAPP: "WHATSAPP",
};

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

// Verifies the OTP the user typed against the stored requestId. `phoneNumber` is
// part of the shared provider interface (MSG91 needs it) but unused here — OTPless
// keys verification off the requestId. Returns a simple { verified, data } shape
// so controllers don't have to know OTPless's response field names.
const verifyOtp = async (phoneNumber, requestId, otp) => {
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
