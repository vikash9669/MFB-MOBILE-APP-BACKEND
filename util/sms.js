// Plain SMS over the Twilio Messaging API.
//
// WHY THIS EXISTS ALONGSIDE THE OTHER TWO TWILIO MODULES
//
//   util/twilio.js      — Verify. Sends only codes it generates itself; it
//                         cannot carry an arbitrary message.
//   util/vendorAlerts.js — the same Messaging API as here, but every send is
//                         behind VENDOR_ALERT_CHANNELS, a switch whose whole
//                         job is to stop a test run phoning a real restaurant
//                         at 3am. Routing rider and admin alerts through it
//                         would mean they could only be enabled by also
//                         enabling vendor calls.
//
// So: same API, separate switch. The GSM-7 normaliser is imported rather than
// copied, because that one is subtle and there should be exactly one of it.
const { forSms } = require("./vendorAlerts");

const TWILIO_API = "https://api.twilio.com/2010-04-01";

const accountSid = () => process.env.TWILIO_ACCOUNT_SID;
const authToken = () => process.env.TWILIO_AUTH_TOKEN;
const smsFrom = () => process.env.TWILIO_SMS_FROM || "";

// Indian numbers, matching every other phone path in this service.
const toE164 = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 0) return "";
  return `+91${digits.slice(-10)}`;
};

/**
 * Sends one SMS. NEVER THROWS — returns { sent, reason } instead.
 *
 * Every caller of this raises a notification as a side effect of something
 * more important (an application being submitted, a rider being approved). A
 * dead SMS provider must not be able to fail that, so the failure is a value,
 * not an exception. Today it always fails: the Twilio account is suspended.
 */
async function sendSms(phone, body) {
  if (!accountSid() || !authToken()) {
    return { sent: false, reason: "Twilio not configured" };
  }
  if (!smsFrom()) {
    return { sent: false, reason: "TWILIO_SMS_FROM not set" };
  }
  const to = toE164(phone);
  if (to.length < 13) {
    return { sent: false, reason: "no usable phone number" };
  }

  try {
    const response = await fetch(`${TWILIO_API}/Accounts/${accountSid()}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid()}:${authToken()}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: smsFrom(), To: to, Body: forSms(body) }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { sent: false, reason: data?.message || `HTTP ${response.status}` };
    }
    return { sent: true, sid: data.sid, status: data.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/** Sends the same message to several numbers. Never throws. */
async function sendSmsMany(phones, body) {
  const results = await Promise.all(phones.map((p) => sendSms(p, body)));
  return { sent: results.filter((r) => r.sent).length, attempted: phones.length, results };
}

module.exports = { sendSms, sendSmsMany, toE164 };
