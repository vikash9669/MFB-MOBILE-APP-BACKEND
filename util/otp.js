// OTP provider dispatcher.
// Both the customer (/auth) and delivery-partner (/delivery/auth) login flows
// call through here. The active SMS/OTP provider is chosen by the MSGPROVIDER
// env var (otpless | msg91 | twilio, default otpless), so switching providers is
// a one-line env change — no controller or mobile-app changes required. The
// dev-mode bypass is handled once, here, so it works for every provider.
const otpless = require("./otpless");
const msg91 = require("./msg91");
const twilio = require("./twilio");

const PROVIDERS = { otpless, msg91, twilio };

const isDevMode = () => process.env.OTP_DEV_MODE === "true";
const DEV_OTP_CODE = () => process.env.OTP_DEV_CODE || "123456";

// Last 10 digits, so "+91 96699 01922", "9669901922" etc. all compare equal.
const normalizePhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);

// Specific test/QA numbers that always accept OTP_DEV_CODE (123456) and never
// hit the real provider — even in production (OTP_DEV_MODE=false). Set via the
// comma-separated OTP_DEV_NUMBERS env. Every OTHER number goes through the live
// provider (Twilio/MSG91/OTPless) and gets a genuine OTP.
const devNumbers = () =>
  String(process.env.OTP_DEV_NUMBERS || "")
    .split(",")
    .map(normalizePhone)
    .filter(Boolean);

// True when the whole app is in dev-bypass mode, OR this specific number is a
// whitelisted test number.
const useDevBypass = (phone) =>
  isDevMode() || devNumbers().includes(normalizePhone(phone));

// Resolves the active provider from MSGPROVIDER, falling back to OTPless for any
// unknown/empty value.
const activeProvider = () => {
  const name = String(process.env.MSGPROVIDER || "otpless")
    .trim()
    .toLowerCase();
  return PROVIDERS[name] || otpless;
};

// Sends an OTP and returns { requestId } for the caller to persist so verify can
// replay it (OTPless) — MSG91 returns a synthetic id but the shape is the same.
const initiateOtp = async (phoneNumber, channel) => {
  if (useDevBypass(phoneNumber)) {
    console.log(
      `MFB-dev ~ OTP for +91${phoneNumber} [dev bypass]: use ${DEV_OTP_CODE()}`
    );
    return { requestId: `dev:${normalizePhone(phoneNumber)}` };
  }
  return activeProvider().initiateOtp(phoneNumber, channel);
};

// Verifies the OTP. Receives the phone AND the stored requestId so it works for
// both providers (OTPless keys off requestId; MSG91 keys off the phone number).
const verifyOtp = async (phoneNumber, requestId, otp) => {
  if (useDevBypass(phoneNumber)) {
    return { verified: String(otp) === DEV_OTP_CODE(), data: { dev: true } };
  }
  return activeProvider().verifyOtp(phoneNumber, requestId, otp);
};

/**
 * True when the app is in full dev-bypass mode AND this is the dev code.
 *
 * For the order handover codes (pickup_otp / drop_otp), which are NOT login
 * OTPs: they are random digits generated per order and texted to the customer,
 * so when the SMS provider is unavailable nobody can ever produce one and no
 * delivery can be completed. This lets OTP_DEV_CODE stand in for them.
 *
 * Keyed on OTP_DEV_MODE alone, deliberately — not on the OTP_DEV_NUMBERS
 * whitelist, which is about specific login numbers. With OTP_DEV_MODE=false,
 * which is what production runs, this is inert and the real code is the only
 * one accepted.
 */
const isDevCode = (otp) => isDevMode() && String(otp ?? "") === DEV_OTP_CODE();

module.exports = {
  initiateOtp,
  verifyOtp,
  isDevCode,
};
