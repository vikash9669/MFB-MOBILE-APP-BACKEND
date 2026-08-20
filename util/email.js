// Outbound mail, over either transport.
//
// TWO WAYS OUT, BECAUSE THE HOST DECIDES WHICH ONE WORKS
//
//   smtp  nodemailer -> EMAIL_HOST:587. Provider-agnostic: Gmail, SendGrid's
//         relay, a mailbox on your own server. The right choice on a VPS.
//   api   one HTTPS POST to SendGrid's v3 endpoint on port 443.
//
// The API path exists because PaaS hosts commonly block outbound SMTP ports —
// Render's free tier blocks 25, 465 and 587 outright — and nothing blocks 443.
// It is also one round trip instead of SMTP's eight, and its errors name the
// offending field instead of returning a bare numeric code.
//
// The cost of the API path is portability: it only speaks to SendGrid. So SMTP
// stays, and EMAIL_TRANSPORT picks.
//
//   EMAIL_TRANSPORT=auto   (default) API when a SendGrid key is present,
//                          otherwise SMTP
//   EMAIL_TRANSPORT=api    force the HTTPS API — use on Render
//   EMAIL_TRANSPORT=smtp   force SMTP — use on your own server
const nodemailer = require("nodemailer");

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * The SendGrid API key.
 *
 * SENDGRID_API_KEY is the explicit name. EMAIL_PASS is accepted as a fallback
 * because on a SendGrid SMTP setup it already holds exactly that value — the
 * SMTP username is the literal string "apikey" and the password IS the API key,
 * so requiring it to be pasted a second time under another name would only be
 * a way to get the two out of step.
 */
const apiKey = () => {
  const explicit = String(process.env.SENDGRID_API_KEY || "").trim();
  if (explicit) return explicit;
  const pass = String(process.env.EMAIL_PASS || "").trim();
  // A SendGrid key is recognisable; another provider's SMTP password is not one.
  return pass.startsWith("SG.") ? pass : "";
};

const smtpConfigured = () =>
  Boolean(String(process.env.EMAIL_HOST || "").trim() && String(process.env.EMAIL_PASS || "").trim());

/** Which transport a send will actually use: "api", "smtp", or null. */
function transportName() {
  const choice = String(process.env.EMAIL_TRANSPORT || "auto").trim().toLowerCase();
  if (choice === "api") return apiKey() ? "api" : null;
  if (choice === "smtp") return smtpConfigured() ? "smtp" : null;
  if (apiKey()) return "api";
  return smtpConfigured() ? "smtp" : null;
}

/**
 * The address mail is sent FROM, and the one shown to recipients as the way to
 * reach us.
 *
 * This is NOT always the SMTP username, and assuming it was is a real bug this
 * codebase shipped. On Gmail the two coincide. On SendGrid the username is the
 * literal string "apikey" for every account, so sending `from: EMAIL_USER`
 * produced "550 MIME message is missing 'From' header" and a footer reading
 * "Mail us: apikey".
 *
 * Whatever is set here must be a verified sender with the provider.
 */
const mailFrom = () => process.env.EMAIL_FROM || process.env.EMAIL_USER || "";

/** True when a send can actually be attempted: a transport and an address. */
const mailConfigured = () => Boolean(transportName() && mailFrom());

// Built lazily so that importing this module never opens a connection, and so a
// changed EMAIL_HOST is picked up without a restart in tests.
let cachedSmtp = null;
function smtpTransport() {
  if (!cachedSmtp) {
    cachedSmtp = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: String(process.env.EMAIL_PORT) === "465",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return cachedSmtp;
}

/** Test seam, and the way to pick up a changed host without a restart. */
const resetTransport = () => {
  cachedSmtp = null;
};

/**
 * Recipients arrive as "a@x.com, b@y.com" because SMTP accepts that verbatim.
 * The API wants them one per object, so this is where the two shapes meet.
 */
const recipientList = (to) =>
  String(to || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

async function sendViaApi({ to, subject, html }) {
  const recipients = recipientList(to);
  if (recipients.length === 0) return { sent: false, reason: "no address on file" };

  const response = await fetch(SENDGRID_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: recipients.map((email) => ({ email })) }],
      from: { email: mailFrom() },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });

  // 202 with an empty body is success. Anything else carries a JSON error whose
  // `field` says which part of the payload SendGrid objected to — the detail
  // SMTP never gives you.
  if (response.status === 202) {
    return { sent: true, transport: "api", id: response.headers.get("x-message-id") || null };
  }
  const detail = await response.json().catch(() => null);
  const why = detail?.errors?.map((e) => `${e.field ? e.field + ": " : ""}${e.message}`).join("; ");
  return { sent: false, transport: "api", reason: why || `HTTP ${response.status}` };
}

async function sendViaSmtp({ to, subject, html }) {
  const info = await smtpTransport().sendMail({ from: mailFrom(), to, subject, html });
  return { sent: true, transport: "smtp", id: info.messageId || null };
}

/**
 * Sends one mail. Never throws — a failed notification must not fail the
 * request that triggered it.
 */
async function sendMail({ to, subject, html }) {
  if (!to) return { sent: false, reason: "no address on file" };

  const transport = transportName();
  if (!transport) {
    return { sent: false, reason: "email not configured (need EMAIL_HOST + EMAIL_PASS, or a SendGrid key)" };
  }
  if (!mailFrom()) return { sent: false, reason: "EMAIL_FROM not set" };

  try {
    return transport === "api"
      ? await sendViaApi({ to, subject, html })
      : await sendViaSmtp({ to, subject, html });
  } catch (err) {
    return { sent: false, transport, reason: err.message };
  }
}

module.exports = {
  sendMail,
  mailFrom,
  mailConfigured,
  transportName,
  recipientList,
  resetTransport,
};
