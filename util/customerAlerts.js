// SMS / WhatsApp to the CUSTOMER, over Twilio.
//
// Separate from util/vendorAlerts.js on purpose. That module's switches
// (VENDOR_ALERT_CHANNELS, VENDOR_ALERT_DRY_RUN) exist so someone can turn off
// the noisy operational chatter aimed at restaurants — escalations, ring-backs
// — without touching anything a paying customer receives. Sharing them would
// mean muting vendor escalations also silently stops customers being told the
// code that gets their food handed over.
//
// The one thing this is used for today is the delivery OTP. That code lived
// only inside the customer app: right when the rider is at the door asking for
// it, the customer may have the app closed, be on a different phone, or have a
// flat battery — and there was no other way to get it. An undeliverable order
// over a number nobody can read is a bad failure for something a text solves.
const TWILIO_API = "https://api.twilio.com/2010-04-01";

const accountSid = () => process.env.TWILIO_ACCOUNT_SID;
const authToken = () => process.env.TWILIO_AUTH_TOKEN;
const whatsappFrom = () => process.env.TWILIO_WHATSAPP_FROM || "";
const smsFrom = () => process.env.TWILIO_SMS_FROM || "";

/**
 * The approved WhatsApp template for the doorstep code.
 *
 * WhatsApp only accepts free-form text inside a 24-hour window that opens when
 * the customer messages the business. A delivery code is business-initiated and
 * is never inside that window, so a plain Body is rejected:
 *
 *   63016 — Failed to send freeform message because you are outside the
 *           allowed window. Please use a Template.
 *
 * Unset is a supported state: the WhatsApp leg then sends free-form, which is
 * what worked against the sandbox and still works within a live 24h window.
 * That keeps this file usable before the template is approved rather than
 * making approval a hard dependency.
 */
const waTemplateSid = () => process.env.TWILIO_WA_OTP_CONTENT_SID || "";

/**
 * How long to wait for Twilio to move a message off "queued" before giving up
 * on it and trying the next channel.
 *
 * This exists because the API returning 201 means *accepted*, not *delivered*.
 * Both real WhatsApp failures seen here — 63015 (recipient not in the sandbox)
 * and 63016 (no template) — arrived asynchronously, several seconds after a 201
 * that the old code read as success. It then stopped, so SMS never fired and
 * the customer silently got nothing while the logs said it had worked.
 *
 * 12s because a 63016 was observed landing between 6 and 12 seconds after the
 * accept, having passed through "sent" on the way.
 *
 * RESIDUAL GAP, stated plainly: polling with any finite budget can still time
 * out on a message that fails later, and that returns "unknown", which is
 * treated as success so the customer is not double-texted. Closing it properly
 * needs a StatusCallback webhook, which needs a publicly reachable URL this
 * deployment does not yet have. The warning logged in that case is the stopgap.
 */
const confirmMs = () => Number(process.env.CUSTOMER_ALERT_CONFIRM_MS || 12000);

/**
 * Which channels to use, in order of preference.
 *
 * Default is whatsapp,sms: WhatsApp is far cheaper and renders better, but not
 * every customer has it, so SMS is the fallback rather than an alternative.
 * Set CUSTOMER_ALERT_CHANNELS to narrow it (e.g. `sms`, or empty to disable).
 */
const channels = () =>
  String(process.env.CUSTOMER_ALERT_CHANNELS ?? "whatsapp,sms")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

/** Logs instead of sending. Its own switch, so staging cannot text real customers. */
const dryRun = () => process.env.CUSTOMER_ALERT_DRY_RUN === "true";

const toE164 = (phone) => `+91${String(phone || "").replace(/\D/g, "").slice(-10)}`;

const usable = (phone) => String(phone || "").replace(/\D/g, "").length >= 10;

const postForm = async (fields) => {
  const encoded = Buffer.from(`${accountSid()}:${authToken()}`).toString("base64");
  const response = await fetch(`${TWILIO_API}/Accounts/${accountSid()}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encoded}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

/** One GET of a message's current state. Returns null if it can't be read. */
const readStatus = async (sid) => {
  try {
    const encoded = Buffer.from(`${accountSid()}:${authToken()}`).toString("base64");
    const r = await fetch(`${TWILIO_API}/Accounts/${accountSid()}/Messages/${sid}.json`, {
      headers: { Authorization: `Basic ${encoded}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
};

// Twilio's terminal states.
//
// "sent" is deliberately NOT a win. On WhatsApp it means only "handed to
// WhatsApp", and a message can sit at "sent" and then turn "undelivered" a few
// seconds later — which is exactly what a real 63016 did here, after this code
// had already reported success. Only delivered/read are proof.
const DEAD = new Set(["failed", "undelivered", "canceled"]);
const LIVE = new Set(["delivered", "read"]);

/**
 * Waits for a just-accepted message to leave "queued", so the caller learns
 * whether it actually went out.
 *
 * Returns "sent" | "dead" | "unknown". "unknown" means it is still in flight
 * after the budget, which is treated as success — the message may well arrive,
 * and sending a duplicate down a second channel is worse than waiting.
 */
async function settle(sid) {
  const budget = confirmMs();
  // Poll about four times across the budget, so a short budget (tests) does not
  // sit through a full production-length sleep before its first read.
  const step = Math.max(10, Math.min(1500, Math.floor(budget / 4)));
  const deadline = Date.now() + budget;
  let last = "queued";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step));
    const m = await readStatus(sid);
    if (m == null) return { outcome: "unknown", status: last };
    last = m.status;
    if (DEAD.has(m.status)) {
      return { outcome: "dead", status: m.status, code: m.error_code, message: m.error_message };
    }
    if (LIVE.has(m.status)) return { outcome: "sent", status: m.status };
  }
  return { outcome: "unknown", status: last };
}

/**
 * Sends one message, trying each enabled channel until one actually goes out.
 *
 * Stops at the first success rather than sending both: a customer who gets the
 * same code twice learns to ignore one of them.
 *
 * "Success" means Twilio moved the message past queued — not merely that the
 * API accepted it. See confirmMs() for why that distinction cost a silent
 * failure.
 *
 * Never throws. Nothing here may fail an order or a delivery.
 */
async function notify(phone, body, { contentSid, contentVariables } = {}) {
  const enabled = channels();
  if (enabled.length === 0) {
    return { sent: false, reason: "no channels enabled (CUSTOMER_ALERT_CHANNELS)" };
  }
  if (!accountSid() || !authToken()) {
    return { sent: false, reason: "Twilio not configured" };
  }
  if (!usable(phone)) {
    return { sent: false, reason: "no usable phone number on file" };
  }
  if (dryRun()) {
    // The number, never the message — the body carries the delivery code.
    console.log(`MFB ~ customer alert ~ DRY RUN ~ would message ${toE164(phone)}`);
    return { sent: false, dryRun: true, reason: "CUSTOMER_ALERT_DRY_RUN" };
  }

  const tried = [];
  for (const channel of enabled) {
    const from = channel === "whatsapp" ? whatsappFrom() : smsFrom();
    if (!from) {
      tried.push(`${channel}: no from-number configured`);
      continue;
    }
    try {
      const prefix = channel === "whatsapp" ? "whatsapp:" : "";

      // WhatsApp goes out as an approved template when we have one, because a
      // business-initiated free-form message is refused (63016). SMS has no
      // such rule and always carries the plain text.
      const useTemplate = channel === "whatsapp" && contentSid;
      const payload = {
        From: `${prefix}${from}`,
        To: `${prefix}${toE164(phone)}`,
        ...(useTemplate
          ? {
              ContentSid: contentSid,
              ...(contentVariables ? { ContentVariables: JSON.stringify(contentVariables) } : {}),
            }
          : { Body: body }),
      };

      const { response, data } = await postForm(payload);
      if (!response.ok) {
        tried.push(`${channel}: ${data?.message || `HTTP ${response.status}`}`);
        continue;
      }

      // Accepted — but not necessarily going anywhere. Wait for a real verdict
      // before declaring victory and skipping the remaining channels.
      const result = await settle(data.sid);
      if (result.outcome === "dead") {
        tried.push(
          `${channel}: ${result.status}${result.code ? ` (${result.code})` : ""} ${result.message || ""}`.trim()
        );
        continue;
      }

      if (result.outcome === "unknown") {
        // Visible, because this is the one path that can still end in a customer
        // never getting their code. The number, never the code itself.
        console.log(
          `MFB ~ customer alert ~ ${channel} to ${toE164(phone)} still "${result.status}" ` +
            `after ${confirmMs()}ms — treating as sent. If it fails later nothing retries.`
        );
      }

      return {
        sent: true,
        channel,
        sid: data.sid,
        status: result.status,
        confirmed: result.outcome === "sent",
        templated: Boolean(useTemplate),
      };
    } catch (err) {
      tried.push(`${channel}: ${err.message}`);
    }
  }

  return { sent: false, reason: tried.join("; ") };
}

/**
 * Texts the customer the code the rider will ask for at the door.
 *
 * Sent when a rider accepts, which is the useful moment: early enough that it
 * has arrived before the doorbell, late enough that it isn't sitting in an
 * inbox from hours earlier for an order nobody is delivering yet.
 */
async function sendDeliveryOtp({ phone, orderId, otp, riderName }) {
  if (!otp) return { sent: false, reason: "no otp" };

  // The three template variables, in the order the approved content declares
  // them. The SMS body below says the same thing in one string — the two must
  // stay in step, which is why they are built together rather than apart.
  //
  // NOTE ON THE EVENTUAL TEMPLATE SHAPE. Meta routes anything that looks like a
  // one-time code into its AUTHENTICATION category, whose body it owns: just the
  // code plus a copy button, no custom wording. If the approved template ends up
  // being that rather than a UTILITY one, this map becomes `{ 1: String(otp) }`
  // and the order number and rider name survive only on the SMS leg. Both
  // attempts at a UTILITY template were rejected — see the account note below.
  const who = riderName || "Your delivery partner";
  const body =
    `${who} is on the way with order #${orderId}. ` +
    `Share this code at the door to receive it: ${otp}. ` +
    `My First Bite will never ask for this code over a call.`;

  return notify(phone, body, {
    contentSid: waTemplateSid(),
    contentVariables: { 1: who, 2: String(orderId), 3: String(otp) },
  });
}

module.exports = { notify, sendDeliveryOtp, channels };
