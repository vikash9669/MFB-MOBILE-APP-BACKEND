// Fixed-window rate limiting for the endpoints where an unlimited caller costs
// money or eventually guesses a secret.
//
// WHY THIS AND NOT express-rate-limit
//
// The dependency list here is deliberately short (express, sequelize, jwt,
// mysql2, axios, nodemailer) and this is ~150 lines with no transitive tree.
// controllers/admin/places.js already grew its own copy of the same idea for
// the geocoding proxy; this is that pattern extracted so the auth surface does
// not become a third copy.
//
// WHAT IT IS NOT
//
// In-process and per-instance. Two backends behind a load balancer each get
// their own allowance, and a restart forgets everything. That is a real
// weakness against a determined attacker and an acceptable one against the two
// things actually happening today: someone spraying /auth/get-otp until the
// Twilio bill hurts, and someone walking a 6-digit OTP or a plaintext password
// list. Redis is the upgrade when there is more than one instance; the call
// sites do not change when it arrives.
//
// TWO COUNTING MODES
//
//   every request   — for endpoints that cost money to serve (sending an SMS).
//                     A legitimate caller is charged the same as an attacker
//                     because the spend is identical.
//   failures only   — for endpoints that guard a secret (OTP check, login).
//                     Counting successes would lock out the person who typed
//                     their password right, which is the one caller we know is
//                     not attacking. A success clears the count outright.

// One global switch, because a limiter that cannot be turned off is a limiter
// nobody dares deploy. Note this is opt-out: an unset variable means ON, so
// forgetting to configure anything still leaves the caps in place.
const DISABLED = String(process.env.RATE_LIMIT_DISABLED || "").toLowerCase() === "true";

// Bounded so a spray of unique keys cannot grow a map without limit. Each
// limiter gets its own store, so this is a per-limiter ceiling.
const MAX_TRACKED = 5000;

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const MINUTE = 60 * 1000;

// req.ip is the socket address unless `trust proxy` is set (see app.js). Behind
// an unconfigured proxy every caller collapses to one bucket — which fails
// closed (everyone shares one small allowance) rather than open, but makes the
// per-IP limits useless, hence the TRUST_PROXY note in .env.example.
const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "unknown");

// Normalised so "+91 96699 01922", "9669901922" and "919669901922" are one
// bucket rather than three free allowances against the same handset.
const normalisePhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
};

exports.clientIp = clientIp;
exports.normalisePhone = normalisePhone;

/**
 * Build a rate-limiting middleware.
 *
 * @param {object}   opts
 * @param {string}   opts.name       Short label, used in the 429 log line.
 * @param {number}   opts.windowMs   Window length.
 * @param {number}   opts.max        Requests (or failures) allowed per window.
 * @param {function} opts.key        req -> bucket key, or null/"" to skip this
 *                                   request entirely (e.g. no phone in body —
 *                                   the handler will 400 it anyway).
 * @param {boolean}  opts.failuresOnly  Count only responses >= 400, and reset
 *                                   the bucket on a success.
 * @param {string}   opts.message    Body message on 429.
 */
function createLimiter({ name, windowMs, max, key, failuresOnly = false, message }) {
  // key -> { count, resetAt }
  const hits = new Map();

  const evictIfFull = (now) => {
    if (hits.size < MAX_TRACKED) return;
    // Cheapest useful eviction: drop everything already expired, and if that
    // frees nothing, drop the oldest insertion (Map preserves insertion order).
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    if (hits.size >= MAX_TRACKED) hits.delete(hits.keys().next().value);
  };

  const bump = (k) => {
    const now = Date.now();
    const seen = hits.get(k);
    if (seen == null || now > seen.resetAt) {
      evictIfFull(now);
      hits.set(k, { count: 1, resetAt: now + windowMs });
      return;
    }
    seen.count += 1;
  };

  const middleware = (req, res, next) => {
    if (DISABLED) return next();

    const k = key(req);
    if (!k) return next();

    const now = Date.now();
    const seen = hits.get(k);
    const live = seen != null && now <= seen.resetAt ? seen : null;
    const used = live ? live.count : 0;

    if (used >= max) {
      const retryAfter = Math.max(1, Math.ceil((live.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", "0");
      // Logged because a real lockout of a real user is a support call, and
      // "was it the limiter?" should be answerable from the log alone. The key
      // can be a phone number, so only its last 4 digits are printed.
      console.log(
        `MFB ~ rate limit hit (${name}) key=***${String(k).slice(-4)} retry_after=${retryAfter}s`
      );
      return res.status(429).json({ message, retry_after: retryAfter });
    }

    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - used - 1)));

    if (failuresOnly) {
      res.on("finish", () => {
        // Only a REJECTED CREDENTIAL counts — 401 and 403.
        //
        // Not every 4xx. A 400 means the request was malformed: the phone had
        // 9 digits, the two password boxes disagreed, the OTP field held four
        // characters. None of those is a guess at a secret, and counting them
        // meant somebody fumbling a reset form eight times was locked out for
        // fifteen minutes without ever having typed a wrong code. 404 is
        // likewise a wrong address, not a wrong answer.
        //
        // 429 is excluded so a limiter can never feed itself, and 5xx because
        // our own outage is not the caller's failed guess.
        if (res.statusCode === 401 || res.statusCode === 403) {
          bump(k);
        } else if (res.statusCode < 400) {
          hits.delete(k);
        }
      });
    } else {
      bump(k);
    }

    return next();
  };

  // Exposed for tests, and for anything that needs to clear a bucket after an
  // out-of-band success (a verify that succeeds should forgive the sends).
  middleware.reset = (k) => hits.delete(k);
  middleware.clear = () => hits.clear();
  return middleware;
}

exports.createLimiter = createLimiter;

// ── The limiters, one per risk ─────────────────────────────────────────────
//
// Every window and cap is env-overridable, because the right number depends on
// traffic nobody has measured yet. The defaults are set so a real person having
// a bad day — no signal, mistyped code, app reinstalled — does not hit them.

// SENDING an OTP costs a Twilio/MSG91 message every time. Two limiters, both
// applied: per phone stops one handset being SMS-bombed, per IP stops one
// caller spraying thousands of different numbers. Neither alone is enough —
// the per-phone cap is trivially dodged by rotating numbers, and the per-IP cap
// says nothing about a botnet pointed at one victim.
exports.otpSendPerPhone = createLimiter({
  name: "otp-send/phone",
  windowMs: num(process.env.OTP_SEND_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.OTP_SEND_MAX_PER_PHONE, 5),
  key: (req) => {
    const phone = normalisePhone(req.body?.phone_number ?? req.body?.phone);
    return phone ? `phone:${phone}` : null;
  },
  message: "Too many OTP requests for this number. Please wait a few minutes and try again.",
});

exports.otpSendPerIp = createLimiter({
  name: "otp-send/ip",
  windowMs: num(process.env.OTP_SEND_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.OTP_SEND_MAX_PER_IP, 20),
  key: (req) => `ip:${clientIp(req)}`,
  message: "Too many OTP requests. Please wait a few minutes and try again.",
});

// CHECKING an OTP is free to serve but guesses a 6-digit secret. Failures only:
// someone who gets it right first time is never counted.
exports.otpVerify = createLimiter({
  name: "otp-verify",
  windowMs: num(process.env.OTP_VERIFY_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.OTP_VERIFY_MAX, 8),
  key: (req) => {
    const phone = normalisePhone(req.body?.phone_number ?? req.body?.phone);
    // Falls back to the IP rather than skipping: a caller who omits the phone
    // still gets counted, so the cap cannot be dodged by leaving it out.
    return phone ? `phone:${phone}` : `ip:${clientIp(req)}`;
  },
  failuresOnly: true,
  message: "Too many incorrect codes. Please wait a few minutes and request a new OTP.",
});

// Panel login. Passwords in store_users are PLAINTEXT (see admin/auth.js), so
// an unlimited login endpoint is an offline-quality attack served online. Both
// limiters apply: per account so one target cannot be ground down, per IP so
// one attacker cannot walk a list of accounts.
exports.loginPerAccount = createLimiter({
  name: "login/account",
  windowMs: num(process.env.LOGIN_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.LOGIN_MAX_PER_ACCOUNT, 8),
  key: (req) => {
    const username = String(req.body?.username ?? "").trim().toLowerCase();
    return username ? `user:${username}` : null;
  },
  failuresOnly: true,
  message: "Too many failed sign-in attempts for this account. Please wait and try again.",
});

exports.loginPerIp = createLimiter({
  name: "login/ip",
  windowMs: num(process.env.LOGIN_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.LOGIN_MAX_PER_IP, 30),
  key: (req) => `ip:${clientIp(req)}`,
  failuresOnly: true,
  message: "Too many failed sign-in attempts. Please wait and try again.",
});

// Changing a password re-checks the current one, so it is a password oracle for
// anyone holding a stolen token. Keyed on the account, not the IP.
exports.passwordChange = createLimiter({
  name: "password-change",
  windowMs: num(process.env.LOGIN_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.LOGIN_MAX_PER_ACCOUNT, 8),
  key: (req) => (req.panel?.user_id ? `user:${req.panel.user_id}` : null),
  failuresOnly: true,
  message: "Too many attempts. Please wait and try again.",
});

// Self-signup creates a row and sends an SMS, so it is both a spend and a way
// to fill store_users with junk. Every request counts, not just failures.
exports.register = createLimiter({
  name: "register",
  windowMs: num(process.env.REGISTER_WINDOW_MIN, 60) * MINUTE,
  max: num(process.env.REGISTER_MAX_PER_IP, 5),
  key: (req) => `ip:${clientIp(req)}`,
  message: "Too many sign-up attempts. Please wait a while and try again.",
});

// ADMIN_API_KEY is a single shared secret checked by string comparison, with no
// account behind it to lock. This is the only thing standing between a guesser
// and every /delivery/admin/* and /notify/push call.
exports.adminKey = createLimiter({
  name: "admin-key",
  windowMs: num(process.env.ADMIN_KEY_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.ADMIN_KEY_MAX_FAILURES, 10),
  key: (req) => `ip:${clientIp(req)}`,
  failuresOnly: true,
  message: "Too many failed attempts.",
});

// The customer's door code. The caller is an authenticated rider, so this is
// not anonymous abuse — it is a rider brute-forcing "delivered" without
// handing the food over, which pays them and closes the order. Keyed on the
// partner, so one rider's guessing never blocks another's real delivery.
exports.deliveryCode = createLimiter({
  name: "delivery-code",
  windowMs: num(process.env.DELIVERY_CODE_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.DELIVERY_CODE_MAX_FAILURES, 10),
  key: (req) => (req.user?.dp_id ? `dp:${req.user.dp_id}` : `ip:${clientIp(req)}`),
  failuresOnly: true,
  message: "Too many incorrect codes. Please check with the customer and try again shortly.",
});

// The Google Places proxy in controllers/places.js bills per call. It is behind
// a customer token, so this is not anonymous abuse — it is one account (or one
// app stuck in a loop on a keystroke handler) running up a Google invoice.
// Keyed on the customer, and generous, because a single address search is
// legitimately several requests: autocomplete fires per keystroke.
exports.placesLookup = createLimiter({
  name: "places-lookup",
  windowMs: num(process.env.PLACES_LOOKUP_WINDOW_MIN, 10) * MINUTE,
  max: num(process.env.PLACES_LOOKUP_MAX, 120),
  key: (req) => (req.user?.user_id ? `user:${req.user.user_id}` : `ip:${clientIp(req)}`),
  message: "Too many address lookups. Please wait a moment and try again.",
});

// Refresh tokens are signed, so guessing one is not the worry; an app stuck in
// a refresh loop is. Generous, and per IP.
exports.tokenRefresh = createLimiter({
  name: "token-refresh",
  windowMs: num(process.env.REFRESH_WINDOW_MIN, 15) * MINUTE,
  max: num(process.env.REFRESH_MAX_PER_IP, 60),
  key: (req) => `ip:${clientIp(req)}`,
  failuresOnly: true,
  message: "Too many token refresh attempts. Please sign in again.",
});
