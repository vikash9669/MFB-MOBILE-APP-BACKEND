// Who is allowed to receive a real message.
//
// WHY THIS EXISTS
//
// The backend runs against a clone of the production database. Every vendor
// row, customer row and delivery address in it belongs to a real person with a
// real phone. A single test order fans out to several of them: the vendor gets
// an alert, the customer gets a delivery code, admin staff get an escalation.
// Placing that order from a laptop in Indore rings a restaurant that never
// signed up for it.
//
// The old protection was a set of dry-run switches that logged instead of
// sending. Those were removed on purpose — a switch that silently sends nothing
// is indistinguishable from a broken integration, and one of them had been on
// for weeks without anybody noticing. This is the replacement, and it is a
// different shape: it does not mute a channel, it restricts the audience. A
// message to an allowed recipient goes out for real, over the real provider,
// and a failure is still a visible failure.
//
// HOW IT BEHAVES
//
//   LIVE_SEND_ALLOWLIST unset or "*"   every recipient is allowed (production)
//   LIVE_SEND_ALLOWLIST="9669901922,me@x.com"
//                                      only those two; everything else refused
//
// UNSET MEANS EVERYTHING SENDS, and that default is deliberate. The opposite —
// defaulting to a closed list — means a production deploy that forgets this
// variable delivers nothing at all, which is exactly the failure the dry-run
// switches produced. Opt in to the restriction; never opt out of working.
//
// A refusal is not an error. It returns the same `{ sent: false, reason }`
// shape every other non-send uses, so callers already handle it.

// Phones are compared on their last 10 digits so "+91 96699 01922",
// "919669901922" and "9669901922" are one entry rather than three misses.
const phoneKey = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const emailKey = (value) => String(value ?? "").trim().toLowerCase();

const isEmail = (value) => String(value ?? "").includes("@");

/** Normalises one recipient to the form it is stored under. */
const keyFor = (recipient) => (isEmail(recipient) ? emailKey(recipient) : phoneKey(recipient));

// Parsed form is memoised against the raw string, so a normal send does no
// work, and a test that changes the env still sees the change.
let cache = { raw: null, set: null, open: true };

const parse = () => {
  const raw = String(process.env.LIVE_SEND_ALLOWLIST ?? "");
  if (cache.raw === raw) return cache;

  const trimmed = raw.trim();
  // Empty or "*" — no restriction at all.
  const open = trimmed === "" || trimmed === "*";
  const set = new Set(
    trimmed
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e && e !== "*")
      .map(keyFor)
      .filter(Boolean)
  );

  cache = { raw, set, open };
  if (!open) {
    // Loud, once per configuration change. Somebody debugging "why did the
    // vendor not get the SMS" should find the answer in the log rather than in
    // this file.
    console.log(
      `MFB ~ LIVE SEND ALLOWLIST ACTIVE ~ ${set.size} recipient(s) may receive real ` +
        `messages; everything else is refused. Unset LIVE_SEND_ALLOWLIST to send to everyone.`
    );
  }
  return cache;
};

/** True when no restriction is configured. */
const unrestricted = () => parse().open;

/** True when this recipient may be sent to. */
const allows = (recipient) => {
  const { open, set } = parse();
  if (open) return true;
  const key = keyFor(recipient);
  return Boolean(key) && set.has(key);
};

// Enough of the recipient to recognise your own number in a log, not enough to
// be a list of real people's contact details.
const mask = (recipient) =>
  isEmail(recipient)
    ? emailKey(recipient).replace(/^(.{2}).*(@.*)$/, "$1***$2")
    : `***${phoneKey(recipient).slice(-4)}`;

/**
 * The guard callers use.
 *
 * @returns null when the send may proceed, or a ready-to-return
 *          `{ sent: false, ... }` result when it must not.
 */
const blocked = (recipient, channel = "message") => {
  if (allows(recipient)) return null;
  console.log(
    `MFB ~ live-send allowlist ~ refused ${channel} to ${mask(recipient)} ` +
      `(not in LIVE_SEND_ALLOWLIST)`
  );
  return {
    sent: false,
    blocked: true,
    reason: "recipient not in LIVE_SEND_ALLOWLIST",
  };
};

module.exports = { allows, blocked, unrestricted, mask, keyFor };
