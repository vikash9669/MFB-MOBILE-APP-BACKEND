// Which web origins this API trusts.
//
// One list, used for two things: deciding CORS headers, and deciding where a
// customer may be sent back to after an off-site payment. Keeping them the same
// list is deliberate — an origin we would not talk to is not one we should hand
// a returning customer to.
//
// ADMIN_PANEL_ORIGINS is comma-separated. The Vite defaults stay so a fresh
// checkout works with no setup.
const DEFAULTS = "http://localhost:5173,http://127.0.0.1:5173";

// Character-walk rather than a regex: /\/+$/ backtracks quadratically on a
// long run of slashes, and these values can arrive from a request header.
const trimTrailingSlashes = (s) => {
  let end = String(s).length;
  while (end > 0 && String(s)[end - 1] === "/") end -= 1;
  return String(s).slice(0, end);
};

const list = () =>
  String(process.env.ADMIN_PANEL_ORIGINS || DEFAULTS)
    .split(",")
    .map((o) => trimTrailingSlashes(o.trim()))
    .filter(Boolean);

const allows = (origin) => Boolean(origin) && list().includes(trimTrailingSlashes(origin));

// Origins we have already complained about, so a misconfigured front end logs
// once rather than on every request.
//
// A CORS rejection is otherwise completely silent from the server's side: we
// return a perfectly good 200, the browser throws the body away, and nothing
// anywhere says why the site looks empty. That is a miserable thing to debug
// against a deployed host, so the first request from an unknown origin says
// exactly what to add and where.
const complained = new Set();

function noteRejected(origin) {
  if (!origin || complained.has(origin)) return;
  complained.add(origin);
  console.log(
    `MFB ~ CORS ~ blocked origin ${origin} — add it to ADMIN_PANEL_ORIGINS ` +
      `(comma-separated). Currently allowed: ${list().join(", ") || "(none)"}`
  );
}

/**
 * Where to send a browser after an off-site round trip.
 *
 * Prefers the origin the request actually came from, because that is the only
 * value that is right by construction: the customer is already there. It is
 * checked against the allowlist first, so a forged Origin header cannot turn a
 * payment return into an open redirect to somewhere else.
 *
 * Falls back to configuration for callers with no browser attached — sweepers
 * and webhooks run with no request at all.
 *
 * The env fallback is what made this worth writing: STOREFRONT_URL unset on a
 * deployed host silently means "http://localhost:5173", so a customer who had
 * genuinely paid was redirected to their own machine and saw nothing.
 */
function webBase(req) {
  const origin = req && req.headers && req.headers.origin;
  if (allows(origin)) return trimTrailingSlashes(origin);

  const configured = process.env.STOREFRONT_URL || process.env.PANEL_URL || "";
  if (configured) return trimTrailingSlashes(configured);

  return list()[0] || "http://localhost:5173";
}

module.exports = { list, allows, webBase, noteRejected };
