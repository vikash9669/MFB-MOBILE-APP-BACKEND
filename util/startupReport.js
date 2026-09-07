// What the process says about itself when it starts.
//
// The boot log used to be one line — and that line was a warning from a
// sweeper. Nothing said the database had connected, nothing said which port was
// listening, and nothing said which integrations were live. On a laptop you can
// shrug at that; on a host where the only window into the process is its log,
// "did it start?" and "is email even configured?" become unanswerable.
//
// NOTHING HERE PRINTS A SECRET. Integrations are reported by presence and by
// the identifiers that are already public — a from-number, a project id, an
// SMTP host, a from-address. Never a key, token or password.
const os = require("os");
const { transportName } = require("./email");
const origins = require("./origins");
const gateway = require("./gateway");

const P = "MFB ~ ";
const line = (s = "") => console.log(P + s);
const rule = () => line("─".repeat(66));

const set = (v) => typeof v === "string" && v.trim() !== "";
const yes = "configured";
const no = "NOT configured";

/** Describes each integration: whether it is usable, and what it will use. */
function integrations() {
  const provider = (process.env.MSGPROVIDER || "otpless").toLowerCase();

  const otpReady =
    provider === "twilio"
      ? set(process.env.TWILIO_ACCOUNT_SID) && set(process.env.TWILIO_VERIFY_SERVICE_SID)
      : provider === "msg91"
        ? set(process.env.MSG91_AUTH_KEY) && set(process.env.MSG91_TEMPLATE_ID)
        : set(process.env.OTPLESS_CLIENT_ID) && set(process.env.OTPLESS_CLIENT_SECRET);

  const twilio = set(process.env.TWILIO_ACCOUNT_SID) && set(process.env.TWILIO_AUTH_TOKEN);

  return [
    ["OTP login", otpReady, `${provider}${otpReady ? "" : " — missing credentials"}`],
    ["SMS", twilio && set(process.env.TWILIO_SMS_FROM), `Twilio ${process.env.TWILIO_SMS_FROM || ""}`.trim()],
    [
      "WhatsApp",
      twilio && set(process.env.TWILIO_WHATSAPP_FROM),
      `Twilio ${process.env.TWILIO_WHATSAPP_FROM || ""}`.trim() +
        (set(process.env.TWILIO_WA_OTP_CONTENT_SID) ? " (OTP template set)" : " (no OTP template)"),
    ],
    ["Voice", twilio && set(process.env.TWILIO_VOICE_FROM), `Twilio ${process.env.TWILIO_VOICE_FROM || ""}`.trim()],
    [
      "Email",
      Boolean(transportName()) && set(process.env.EMAIL_FROM || process.env.EMAIL_USER),
      transportName() === "api"
        ? `SendGrid HTTPS API as ${process.env.EMAIL_FROM || "?"}`
        : `SMTP ${process.env.EMAIL_HOST || "?"}:${process.env.EMAIL_PORT || 587} as ${process.env.EMAIL_FROM || process.env.EMAIL_USER || "?"}`,
    ],
    ["Push (FCM)", set(process.env.FCM_PROJECT_ID) && set(process.env.FCM_PRIVATE_KEY), process.env.FCM_PROJECT_ID || ""],
    // Asks the gateway module rather than naming a provider. This row used to
    // be hardcoded to PhonePe — it checked PHONEPE_CLIENT_ID and printed
    // "PhonePe <PHONEPE_ENV or UAT>" whatever PAYMENT_PROVIDER said. A
    // deployment correctly switched to Cashfree PROD therefore reported
    // "PhonePe UAT" at boot, which is the one line an operator checks to
    // confirm the switch worked.
    [
      "Payments",
      gateway.isConfigured(),
      `${gateway.name} ${gateway.config().env}`,
    ],
    ["Maps", set(process.env.GOOGLE_MAPS_API_KEY), "Google"],
  ];
}

/**
 * Things that are working as configured but will surprise somebody.
 *
 * Deliberately not errors: each one is a legitimate setting in some
 * environment and a mistake in another, and the only way to tell them apart is
 * to put them in front of a human at boot.
 */
function warnings() {
  const w = [];
  const env = process.env.NODE_ENV || "development";

  if (String(process.env.OTP_DEV_MODE).toLowerCase() === "true") {
    w.push("OTP_DEV_MODE=true — EVERY number bypasses the provider. Never correct in production.");
  }
  const devNums = String(process.env.OTP_DEV_NUMBERS || "").split(",").filter((x) => x.trim());
  if (devNums.length) {
    w.push(`OTP_DEV_NUMBERS — ${devNums.length} number(s) skip OTP entirely and accept OTP_DEV_CODE.`);
  }
  // Keyed on the ACTIVE gateway, not on PhonePe. The old test read PHONEPE_ENV
  // unconditionally, so a deployment running Cashfree in PROD was warned that
  // its payments were test money, while one running Cashfree in sandbox with
  // PHONEPE_ENV=PROD was told nothing at all — the warning was backwards in
  // both directions.
  if (String(gateway.config().env || "UAT").toUpperCase() !== "PROD") {
    w.push(
      `${gateway.name.toUpperCase()} is not in PROD — payments use test money.`
    );
  }
  // The gateway webhook is what turns a PENDING intent into a PAID order
  // without the customer having to stay on the confirm screen. Its URL is built
  // as `${PUBLIC_API_URL}/payment/callback`, and an unset value collapses that
  // to the relative "/payment/callback", which no gateway can reach.
  //
  // Nothing errors when that happens. The payment succeeds at the bank, the
  // callback is never delivered, and the intent sits PENDING until the sweeper
  // gives up on it — the "charged with no order" case. Worth a line at boot
  // because it is invisible until a real customer is out of pocket.
  if (!set(process.env.PUBLIC_API_URL)) {
    w.push(
      "PUBLIC_API_URL is empty — the gateway webhook URL is relative and will never be called. " +
        "Payments will stay PENDING even when the money has left the customer's account."
    );
  }
  if (/change_me|dev_access_secret/i.test(process.env.JWT_SECRET_KEY || "")) {
    w.push("JWT_SECRET_KEY still looks like the shipped default — anyone who knows it can mint tokens.");
  }
  if (!set(process.env.TRUST_PROXY) && env === "production") {
    w.push("TRUST_PROXY is empty — behind a proxy every caller shares one rate-limit bucket.");
  }
  if (String(process.env.RATE_LIMIT_DISABLED).toLowerCase() === "true") {
    w.push("RATE_LIMIT_DISABLED=true — auth and OTP endpoints are uncapped.");
  }
  if (String(process.env.AUTO_MIGRATE || "").toLowerCase() === "false") {
    w.push("AUTO_MIGRATE=false — the schema will not be brought up to date at boot.");
  }
  if (String(process.env.DELIVERY_DEMO).toLowerCase() === "true") {
    w.push("DELIVERY_DEMO=true — new partners get seeded demo orders.");
  }
  return w;
}

/** Printed once the database is up but before the port opens. */
function reportBoot({ dbName, dbHost, dbPort, timezone, schema }) {
  rule();
  line(`My First Bite backend  ·  node ${process.version}  ·  pid ${process.pid}  ·  ${os.hostname()}`);
  line(`env        ${process.env.NODE_ENV || "development"}`);
  line(`database   connected — ${dbName} @ ${dbHost}:${dbPort} (session tz ${timezone})`);
  line(`schema     ${schema}`);
  // Which browsers may talk to this API. A deployed front end missing from
  // this list fails with an empty page and no server-side error, so the list
  // is worth stating plainly at boot rather than inferring it from a bug report.
  line(`cors       ${origins.list().join(", ") || "(none)"}`);
  // Which gateway is taking money, and whether it can. Switching provider is a
  // single env var, so the boot log is the fastest way to confirm the process
  // agrees with what the dashboard was configured for.
  {
    const g = gateway.config();
    line(
      `payments   ${gateway.name} ${g.env} — ` +
        `${gateway.isConfigured() ? yes : no}` +
        `${gateway.qrConfigured() ? ", doorstep QR on" : ", doorstep QR off"}`
    );
  }
  rule();
  line("integrations");
  for (const [name, ok, detail] of integrations()) {
    line(`  ${name.padEnd(11)} ${(ok ? yes : no).padEnd(15)} ${ok ? detail : ""}`.trimEnd());
  }
  const w = warnings();
  if (w.length) {
    line("");
    line(`warnings (${w.length})`);
    w.forEach((x) => line(`  ! ${x}`));
  }
  rule();
}

/** Printed when the port is actually open — the "we are up" line. */
function reportListening(port) {
  line(`listening  0.0.0.0:${port}   — ready`);
  rule();
}

/**
 * The database never came up. Say why in one readable line, then exit non-zero.
 *
 * Previously this printed a raw Sequelize stack and left the process running
 * with no listener: the platform sees a live process, the health check fails,
 * and the log is a wall of node internals. Exiting lets the host restart it and
 * makes the failure legible.
 */
function reportFatal(err) {
  rule();
  line("FATAL — could not start");
  line(`  ${err.name || "Error"}: ${err.message}`);
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i.test(err.message)) {
    line(`  The database at ${process.env.DB_HOST}:${process.env.DB_PORT} did not answer.`);
    line("  Check DB_HOST / DB_PORT, that the server is running, and that this host is");
    line("  allowed to connect to it (remote MySQL access, firewall, IP allowlist).");
  } else if (/Access denied/i.test(err.message)) {
    line("  Credentials were rejected. Check DB_USER_NAME / DB_PASSWORD and that the");
    line("  user is granted rights on DB_NAME from this host.");
  } else if (/Unknown database/i.test(err.message)) {
    line(`  The database "${process.env.DB_NAME}" does not exist on that server.`);
  }
  rule();
}

module.exports = { reportBoot, reportListening, reportFatal, integrations, warnings };
