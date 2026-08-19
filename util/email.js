const nodemailer = require("nodemailer");

// Outbound mail, over plain SMTP so the provider is a config choice rather than
// a code dependency. Works unchanged against Gmail, SendGrid's relay, or a
// mailbox on the domain's own host.
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * The address mail is sent FROM, and the one shown to recipients as the way to
 * reach us.
 *
 * This is NOT always the SMTP username, and assuming it was is a real bug this
 * codebase shipped. On Gmail the two coincide — you authenticate as
 * care@example.com and send as care@example.com. On SendGrid's relay the
 * username is the literal string "apikey" for every account on the platform, so
 * sending `from: EMAIL_USER` produces:
 *
 *   550 MIME message is missing 'From' header
 *
 * and the mail footer renders "Mail us: apikey".
 *
 * So EMAIL_FROM is the address, EMAIL_USER is the credential, and they are
 * allowed to differ. The fallback keeps every Gmail-style config working with
 * no change: where the username IS the address, it is still the right answer.
 *
 * Whatever is set here must be a verified sender with the provider — SendGrid
 * rejects unverified ones outright.
 */
const mailFrom = () => process.env.EMAIL_FROM || process.env.EMAIL_USER || "";

/** True when a send can actually be attempted: a host, a credential and an address. */
const mailConfigured = () =>
  Boolean(process.env.EMAIL_HOST && process.env.EMAIL_PASS && mailFrom());

module.exports = {
  transporter,
  mailFrom,
  mailConfigured,
};
