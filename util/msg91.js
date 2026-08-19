// Thin wrapper over the MSG91 OTP API (v5).
// Selected when MSGPROVIDER=msg91. Unlike OTPless, MSG91 keeps the OTP keyed by
// mobile number on its own side, so there is no requestId to round-trip —
// verify only needs the phone + the code the user typed. We still return a
// synthetic requestId from send so the callers' "was an OTP requested first?"
// gate keeps working unchanged across providers.
//
// Setup (MSG91 dashboard): create an OTP SMS template (DLT-approved, containing
// ##OTP##) and copy its template id + your auth key into .env. Docs:
// https://docs.msg91.com/otp

const MSG91_BASE_URL = "https://control.msg91.com/api/v5";

const authKey = () => process.env.MSG91_AUTH_KEY;
const templateId = () => process.env.MSG91_TEMPLATE_ID;
const otpExpiry = () => process.env.MSG91_OTP_EXPIRY || "10"; // minutes
const otpLength = () => process.env.MSG91_OTP_LENGTH || "6";
const senderId = () => process.env.MSG91_SENDER_ID; // optional DLT sender id

// MSG91 wants the full number with country code, digits only (e.g. 919812345678).
const toMobile = (phoneNumber) =>
  `91${String(phoneNumber).replace(/\D/g, "").slice(-10)}`;

const assertConfigured = () => {
  if (!authKey() || !templateId()) {
    throw new Error(
      "MSG91 is not configured — set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID in .env"
    );
  }
};

// Sends an OTP via MSG91 (SMS). MSG91 generates, sends and stores the code
// against the mobile number, so we only return a placeholder requestId for the
// caller to persist.
const initiateOtp = async (phoneNumber /* , channel */) => {
  assertConfigured();

  const params = new URLSearchParams({
    template_id: templateId(),
    mobile: toMobile(phoneNumber),
    otp_expiry: String(otpExpiry()),
    otp_length: String(otpLength()),
  });
  if (senderId()) {
    params.set("sender", senderId());
  }

  const response = await fetch(`${MSG91_BASE_URL}/otp?${params.toString()}`, {
    method: "POST",
    headers: {
      authkey: authKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.type === "error") {
    throw new Error(data?.message || "Failed to send OTP (MSG91)");
  }

  return { requestId: data?.request_id || `msg91:${toMobile(phoneNumber)}` };
};

// Verifies the code the user typed against MSG91's stored OTP for this mobile.
// requestId is ignored (MSG91 keys off the number) but kept in the signature so
// the provider interface matches OTPless.
const verifyOtp = async (phoneNumber, _requestId, otp) => {
  assertConfigured();

  const params = new URLSearchParams({
    mobile: toMobile(phoneNumber),
    otp: String(otp),
  });

  const response = await fetch(
    `${MSG91_BASE_URL}/otp/verify?${params.toString()}`,
    { method: "GET", headers: { authkey: authKey() } }
  );

  const data = await response.json().catch(() => ({}));
  const verified = response.ok && data?.type === "success";

  return { verified, data };
};

module.exports = {
  initiateOtp,
  verifyOtp,
};
