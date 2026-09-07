// Settings that must never reach production, checked before the port opens.
//
// The boot banner has always WARNED about these. A warning is not a control:
// JWT_SECRET_KEY was found sitting at the shipped default on the live backend,
// having printed that warning on every deploy, and tokens signed on a laptop
// with no credentials at all were accepted as staff. Anything in here is
// therefore a refusal, not a line of yellow text.
//
// Only for faults where RUNNING IS WORSE THAN BEING DOWN. A forgeable signing
// key qualifies: every session, every admin endpoint and every rider action is
// authenticated by it, so with the default in place the backend has no
// authentication at all and no log can tell a real token from a minted one.
// Faults that can be closed silently do NOT belong here — the OTP dev bypass is
// simply ignored in production (see util/otp.js) rather than taking the
// platform down over an env var.

/**
 * Secrets shipped in the repo, in .env.example, or otherwise public enough that
 * possessing one proves nothing. Substring match, case-insensitive, because
 * these get pasted with suffixes ("change_me_in_prod", "dev_access_secret_2").
 */
const PUBLIC_SECRET_MARKERS = ["change_me", "dev_access_secret", "your_secret", "changeme"];

const looksPublic = (value) => {
  const v = String(value || "");
  return PUBLIC_SECRET_MARKERS.some((m) => v.toLowerCase().includes(m));
};

/**
 * Every reason this process must not serve production traffic.
 *
 * Returns an array of strings — empty means clear. Split from the throwing
 * wrapper so tests can assert the rules without a process that exits.
 */
function productionBlockers(env = process.env) {
  if ((env.NODE_ENV || "development") !== "production") return [];

  const blockers = [];

  // Both keys, because a refresh token mints access tokens: leaving the refresh
  // secret at the default is the same hole one step removed.
  for (const key of ["JWT_SECRET_KEY", "JWT_REFRESH_SECRET_KEY"]) {
    const value = env[key];
    if (!value) {
      blockers.push(`${key} is not set — every token this process issues would be unsigned or predictable.`);
    } else if (looksPublic(value)) {
      blockers.push(
        `${key} is still a placeholder from the repo. Anyone with the source can mint tokens for any account, including staff.`
      );
    }
  }

  return blockers;
}

/**
 * Refuses to continue when production is misconfigured.
 *
 * Called before app.listen so a bad deploy fails visibly at boot instead of
 * coming up and quietly accepting forged credentials. The message says what to
 * do, because whoever reads it is mid-incident.
 */
function assertProductionSafe(env = process.env) {
  const blockers = productionBlockers(env);
  if (blockers.length === 0) return;

  const lines = [
    "",
    "  REFUSING TO START — unsafe production configuration",
    "",
    ...blockers.map((b) => `  ✗ ${b}`),
    "",
    "  Set a long random value for each on the host, redeploy, and note that",
    "  rotating them signs everyone out — existing tokens stop validating.",
    "  Generate one with:  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    "",
  ].join("\n");

  const err = new Error(lines);
  err.configurationFault = true;
  throw err;
}

module.exports = { assertProductionSafe, productionBlockers, looksPublic };
