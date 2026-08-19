// Thin wrapper over the Twilio Verify API (v2).
// Selected when MSGPROVIDER=twilio. Like MSG91, Twilio keeps the OTP on its own
// side keyed by phone number, so there is no requestId to round-trip — verify
// only needs the phone + the code. We return Twilio's verification SID as the
// requestId so the callers' "was an OTP requested first?" gate keeps working.
//
// Setup (Twilio console): create a Verify Service (Verify → Services) and copy
// its Service SID (VA…) plus your Account SID + Auth Token into .env. Twilio
// Verify supports SMS and WhatsApp channels natively. Docs:
// https://www.twilio.com/docs/verify/api

const TWILIO_BASE_URL = "https://verify.twilio.com/v2";

const accountSid = () => process.env.TWILIO_ACCOUNT_SID;
const authToken = () => process.env.TWILIO_AUTH_TOKEN;
const serviceSid = () => process.env.TWILIO_VERIFY_SERVICE_SID;

// Twilio wants E.164 (e.g. +919812345678).
const toE164 = (phoneNumber) =>
  `+91${String(phoneNumber).replace(/\D/g, "").slice(-10)}`;

// Twilio Verify channels: sms | whatsapp | call. Map the app's channel names.
const toChannel = (channel) =>
  String(channel || "").trim().toUpperCase() === "WHATSAPP" ? "whatsapp" : "sms";

const basicAuth = () =>
  `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString("base64")}`;

const assertConfigured = () => {
  if (!accountSid() || !authToken() || !serviceSid()) {
    throw new Error(
      "Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID in .env"
    );
  }
};

// Twilio Verify uses form-encoded bodies, not JSON.
const postForm = async (path, fields) => {
  const response = await fetch(`${TWILIO_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

// Starts a verification (sends the OTP). Twilio generates, sends and stores the
// code, so we only return its verification SID for the caller to persist.
const initiateOtp = async (phoneNumber, channel) => {
  assertConfigured();

  const { response, data } = await postForm(
    `/Services/${serviceSid()}/Verifications`,
    { To: toE164(phoneNumber), Channel: toChannel(channel) }
  );

  if (!response.ok || !data?.sid) {
    throw new Error(data?.message || "Failed to send OTP (Twilio)");
  }

  return { requestId: data.sid };
};

// Checks the code the user typed against Twilio's pending verification for this
// number. requestId is ignored (Twilio keys off the number) but kept in the
// signature so the provider interface matches OTPless/MSG91.
const verifyOtp = async (phoneNumber, _requestId, otp) => {
  assertConfigured();

  const { response, data } = await postForm(
    `/Services/${serviceSid()}/VerificationCheck`,
    { To: toE164(phoneNumber), Code: String(otp) }
  );

  // Twilio returns status "approved" (and valid:true) on a correct code; a wrong
  // code returns status "pending", and an expired/exhausted one can 404.
  const verified = response.ok && data?.status === "approved";

  return { verified, data };
};

module.exports = {
  initiateOtp,
  verifyOtp,
};
