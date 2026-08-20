// Password storage for panel accounts — store_users.user_password.
//
// The legacy PHP panel hashes with md5() everywhere it touches a password
// (administration/controllers/Index.php, models/User_Model.php, store/Signup.php
// and friends), and the live database is full of those digests: of 20,477 rows,
// 14,691 hold a 32-character hex digest and the rest are blank.
//
// The Node panel API originally compared the submitted password to the stored
// column directly. Against a development database seeded with plaintext that
// worked, so the mismatch went unnoticed — but against the real data it can
// never match, and every panel login failed with "Invalid username or password"
// no matter how correct the credentials were.
//
// ⚠️ md5 is not an acceptable password hash. It is unsalted and brute-forces at
// billions of guesses per second. We match it here because the alternative is
// locking every existing user out, and because rehashing 14,691 live rows is a
// migration, not a code change. Moving to bcrypt is tracked separately: verify
// with this function, then rehash on next successful sign-in.
//
// Not used by the customer OTP flow. controllers/auth.js stores the provider's
// requestId in this same column between send and verify — an unrelated use of
// the field that must keep comparing raw.
const crypto = require("crypto");

/** The digest the PHP panel would have written for this password. */
const hash = (plain) => crypto.createHash("md5").update(String(plain)).digest("hex");

const isDigest = (stored) => /^[0-9a-f]{32}$/i.test(String(stored || ""));

/**
 * Does `plain` unlock the account holding `stored`?
 *
 * A blank column never matches: thousands of legacy rows have one, and treating
 * "" as a password would let an empty form log into any of them.
 *
 * When the stored value is digest-shaped we compare digests and nothing else.
 * Falling back to a raw comparison there would mean anyone holding the digest —
 * from a backup, a dump, or a SQL injection — could paste it into the password
 * box and sign in without ever cracking it. The raw branch exists only for
 * development databases seeded with plaintext.
 */
function matches(stored, plain) {
  const s = String(stored || "");
  const p = String(plain || "");
  if (!s || !p) return false;
  return isDigest(s) ? timingSafeEqual(s.toLowerCase(), hash(p)) : timingSafeEqual(s, p);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { hash, matches, isDigest };
