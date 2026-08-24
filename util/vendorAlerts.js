// Reaching a vendor when an order lands.
//
// A vendor has no mobile app, so email and the panel bell are both passive:
// they work only if someone happens to be looking. For "start cooking now" that
// is not good enough, which is why the big platforms ring the restaurant.
//
// Two active channels, both over the Twilio account the OTP flow already uses:
//
//   whatsapp — the order summary plus a link to the accept screen
//   call     — a spoken alert that rings the shop phone until answered
//
// These are the Messaging and Voice APIs (api.twilio.com), NOT the Verify API
// in util/twilio.js. Verify only sends codes it generates itself; it cannot
// carry an arbitrary message.
//
// SAFETY: every channel is opt-in via VENDOR_ALERT_CHANNELS and off by default.
// That switch is now the only thing standing between a test run and phoning a
// real restaurant at 3am — the separate dry-run override was removed, so an
// enabled channel always sends for real.

const TWILIO_API = "https://api.twilio.com/2010-04-01";

const accountSid = () => process.env.TWILIO_ACCOUNT_SID;
const authToken = () => process.env.TWILIO_AUTH_TOKEN;
const whatsappFrom = () => process.env.TWILIO_WHATSAPP_FROM || "";
const smsFrom = () => process.env.TWILIO_SMS_FROM || "";
const voiceFrom = () => process.env.TWILIO_VOICE_FROM || "";

/**
 * Which channels are live. Off by default — email and the panel bell already
 * cover the passive case, and these two cost money and ring real phones.
 *
 *   VENDOR_ALERT_CHANNELS=sms,whatsapp,call
 *
 * These are independent, not a fallback chain: enabling two sends two. That is
 * deliberate for a vendor — the point is to be impossible to miss — but it does
 * mean `sms,whatsapp` double-messages the same person, so pick one text channel
 * unless you actually want both.
 */
const enabledChannels = () =>
  new Set(
    String(process.env.VENDOR_ALERT_CHANNELS || "none")
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean)
  );

const toE164 = (phone) => `+91${String(phone || "").replace(/\D/g, "").slice(-10)}`;

const basicAuth = () => {
  const encoded = Buffer.from(`${accountSid()}:${authToken()}`).toString("base64");
  return `Basic ${encoded}`;
};

const postForm = async (path, fields) => {
  const response = await fetch(`${TWILIO_API}${path}`, {
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

/** Nothing here may throw — an alert must never fail an order already placed. */
const guard = async (channel, phone, fn) => {
  if (!enabledChannels().has(channel)) {
    return { sent: false, reason: `${channel} not enabled (VENDOR_ALERT_CHANNELS)` };
  }
  if (!accountSid() || !authToken()) {
    return { sent: false, reason: "Twilio not configured" };
  }
  if (!phone || String(phone).replace(/\D/g, "").length < 10) {
    return { sent: false, reason: "no usable phone number on file" };
  }
  try {
    return await fn();
  } catch (err) {
    console.log(`MFB-error-logs ~ vendor alert ~ ${channel} ~`, err.message);
    return { sent: false, reason: err.message };
  }
};

/**
 * WhatsApp message to the vendor.
 *
 * Business-initiated messages outside the 24-hour customer service window must
 * use a pre-approved template — a plain body will be accepted by the API and
 * then silently not delivered. For testing, the Twilio WhatsApp sandbox works
 * once the vendor's number has joined it.
 */
/**
 * Rewrites a WhatsApp body for SMS.
 *
 * The alert text is authored for WhatsApp, and two of its habits are actively
 * expensive over SMS:
 *
 *   *bold*  — WhatsApp markup. SMS has no formatting, so the asterisks are
 *             delivered literally and the vendor reads "*New order #272403*".
 *   emoji   — and the rupee sign. Neither is in GSM-7, and a single character
 *   and ₹     outside that alphabet re-encodes the WHOLE message as UCS-2,
 *             which cuts the segment size from 160 characters to 70. One
 *             emoji can therefore double or triple what a message costs.
 *
 * So the SMS leg sends the same words, stripped to plain GSM-7 text.
 */
const forSms = (body) =>
  String(body || "")
    .replace(/\*/g, "")
    .replace(/₹\s*/g, "Rs ")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    // Typography from our own copy that also sits outside GSM-7. One of these
    // is enough to re-encode the whole message, and "2 items · Rs 250" was
    // costing a second segment for a separator nobody would miss.
    // Caller-supplied text (a vendor's name) is deliberately NOT touched: a
    // name in Devanagari is worth the extra segment, a middle dot is not.
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Plain SMS to the vendor.
 *
 * Exists because WhatsApp cannot be relied on here: a business-initiated
 * free-form message outside the 24-hour window is refused (63016), and a vendor
 * never messages first, so the window is never open. Until approved templates
 * are in place SMS is the only text channel that actually arrives.
 */
async function smsVendor(phone, body) {
  return guard("sms", phone, async () => {
    if (!smsFrom()) {
      return { sent: false, reason: "TWILIO_SMS_FROM not set" };
    }
    const { response, data } = await postForm(
      `/Accounts/${accountSid()}/Messages.json`,
      { From: smsFrom(), To: toE164(phone), Body: forSms(body) }
    );
    if (!response.ok) {
      return { sent: false, reason: data?.message || `HTTP ${response.status}` };
    }
    return { sent: true, sid: data.sid, status: data.status };
  });
}

async function whatsappVendor(phone, body) {
  return guard("whatsapp", phone, async () => {
    if (!whatsappFrom()) {
      return { sent: false, reason: "TWILIO_WHATSAPP_FROM not set" };
    }
    const { response, data } = await postForm(
      `/Accounts/${accountSid()}/Messages.json`,
      {
        From: `whatsapp:${whatsappFrom()}`,
        To: `whatsapp:${toE164(phone)}`,
        Body: body,
      }
    );
    if (!response.ok) {
      return { sent: false, reason: data?.message || `HTTP ${response.status}` };
    }
    return { sent: true, sid: data.sid, status: data.status };
  });
}

/**
 * Rings the vendor and speaks the alert.
 *
 * The TwiML is passed inline so this needs no publicly reachable webhook — one
 * less thing to stand up, and it keeps working behind ngrok or a private host.
 * The message repeats because a phone answered mid-sentence in a noisy kitchen
 * is a phone call wasted.
 */
async function callVendor(phone, spoken) {
  return guard("call", phone, async () => {
    if (!voiceFrom()) {
      return { sent: false, reason: "TWILIO_VOICE_FROM not set" };
    }
    const say = `<Say voice="alice" language="en-IN">${spoken}</Say>`;
    const twiml = `<Response>${say}<Pause length="1"/>${say}</Response>`;

    const { response, data } = await postForm(
      `/Accounts/${accountSid()}/Calls.json`,
      { From: voiceFrom(), To: toE164(phone), Twiml: twiml }
    );
    if (!response.ok) {
      return { sent: false, reason: data?.message || `HTTP ${response.status}` };
    }
    return { sent: true, sid: data.sid, status: data.status };
  });
}

/** Both active channels for one new order. Never throws. */
async function alertVendorNewOrder({
  orderId,
  vendorName,
  phone,
  itemCount,
  total,
  acceptUrl,
  reminder = 0,
}) {
  const shop = vendorName || "your restaurant";

  // A reminder must not read like the first alert, or the vendor assumes it's a
  // duplicate and ignores it — the opposite of what a chase is for.
  const heading = reminder
    ? `⏰ *Reminder ${reminder}: order #${orderId} still not accepted*`
    : `🛎️ *New order #${orderId}* at ${shop}`;

  const plural = itemCount === 1 ? "" : "s";
  const items = itemCount > 0 ? `${itemCount} item${plural} · ` : "";

  const body =
    `${heading}\n${items}₹${total}\n\n` +
    (reminder
      ? `A customer is waiting. Please accept this order now:\n${acceptUrl}`
      : `Please accept it and start preparing:\n${acceptUrl}`);

  const digits = String(orderId).split("").join(" ");
  const spoken = reminder
    ? `Reminder. Order number ${digits} at ${shop} has still not been accepted. ` +
      `A customer is waiting. Please open your dashboard and accept it now.`
    : `Hello. You have a new order, number ${digits}, at ${shop}. ` +
      `Please open your dashboard to accept it and start preparing.`;

  // Run them together — a slow voice API shouldn't delay the text.
  const [whatsapp, sms, call] = await Promise.all([
    whatsappVendor(phone, body),
    smsVendor(phone, body),
    callVendor(phone, spoken),
  ]);

  return { whatsapp, sms, call };
}

/**
 * Sends one escalation to every admin number on whichever text channels are
 * enabled. Both escalations fan out identically, so they share this.
 */
async function alertPhones(targets, body) {
  const results = await Promise.all(
    targets.flatMap((phone) => [whatsappVendor(phone, body), smsVendor(phone, body)])
  );
  return { sent: results.some((r) => r.sent), recipients: targets.length, results };
}

let warnedNoAdminPhones = false;

/**
 * Admin phone numbers for escalations. Explicit opt-in only.
 *
 * There is deliberately NO fallback to "every account with an admin role".
 * This database has ten of them, carrying personal mobiles, so the fallback
 * meant one WhatsApp per admin per escalation — ten messages for one late
 * order, to people who never asked to be an on-call rota, at ten times the
 * cost. Email already has the same guard (ORDER_ALERT_EMAILS); this is the
 * costlier, more intrusive channel and needs it more.
 *
 * Set ADMIN_ALERT_PHONES to the one or two numbers that should actually ring.
 */
const adminPhones = () => {
  const configured = String(process.env.ADMIN_ALERT_PHONES || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    if (!warnedNoAdminPhones) {
      warnedNoAdminPhones = true;
      console.log(
        "MFB ~ admin WhatsApp escalation is off: set ADMIN_ALERT_PHONES to the " +
          "number(s) that should be alerted when a vendor doesn't accept."
      );
    }
    return [];
  }

  // One message per human, even if a number is listed twice.
  return [...new Set(configured.map((p) => toE164(p)).filter((p) => p.length >= 12))];
};

/**
 * Tells admin staff a vendor has gone quiet, on WhatsApp.
 *
 * The email escalation says the same thing, but email is passive and this is
 * time-critical — the customer is already waiting and the order is minutes from
 * being auto-cancelled. Never throws.
 */
async function alertAdminVendorUnresponsive({
  orderId,
  shop,
  vendorPhone,
  minutesWaiting,
  minutesUntilCancel,
  orderUrl,
}) {
  const targets = adminPhones();
  if (targets.length === 0) {
    return { sent: false, reason: "no admin phone numbers (ADMIN_ALERT_PHONES)" };
  }

  const deadline =
    minutesUntilCancel > 0
      ? `\n\n⏳ Auto-cancels (and refunds) in ${minutesUntilCancel} min.`
      : "";

  const body =
    `🚨 *Order #${orderId} not accepted*\n` +
    `${shop} has not responded for ${minutesWaiting} min.` +
    (vendorPhone ? `\nVendor: ${vendorPhone}` : "") +
    deadline +
    `\n\n${orderUrl}`;

  return alertPhones(targets, body);
}

/** Tells admin staff an order was auto-cancelled. Never throws. */
async function alertAdminAutoCancelled({ orderId, shop, refunded, amount, orderUrl }) {
  const targets = adminPhones();
  if (targets.length === 0) {
    return { sent: false, reason: "no admin phone numbers (ADMIN_ALERT_PHONES)" };
  }

  let money = "This was a cash order, so there is nothing to refund.";
  if (refunded === true) {
    money = `₹${amount} refund submitted to PhonePe.`;
  } else if (refunded === false) {
    money = `⚠️ ₹${amount} was paid online and the REFUND DID NOT GO THROUGH. Refund it by hand.`;
  }

  const body =
    `❌ *Order #${orderId} auto-cancelled*\n` +
    `${shop} never accepted it.\n\n${money}\n\n${orderUrl}`;

  return alertPhones(targets, body);
}

module.exports = {
  alertVendorNewOrder,
  alertAdminVendorUnresponsive,
  alertAdminAutoCancelled,
  whatsappVendor,
  smsVendor,
  forSms,
  callVendor,
  enabledChannels,
  adminPhones,
};
