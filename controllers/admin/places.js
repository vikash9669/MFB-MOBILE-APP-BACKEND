// Address lookup for the panel's map picker.
//
// WHY THIS IS A SERVER ENDPOINT AND NOT A BROWSER CALL
//
// The picker draws OpenStreetMap tiles, which need no credential, but turning
// typed text into a coordinate does. Two ways to get that into a browser, both
// rejected:
//
//   * ship GOOGLE_MAPS_API_KEY to the page — it is unrestricted and billable by
//     anyone who reads the source;
//   * add a referrer-restricted web key — a second credential to obtain, and
//     the panel does not have one yet (see AddressMap.tsx), so the picker would
//     ship dead.
//
// So the browser asks us and the key stays on the server, where it already
// works for dispatch geocoding.
//
// THESE ROUTES ARE PUBLIC, because a vendor signing up needs the picker before
// they have an account. That makes them a billable endpoint anyone can call, so
// they are rate limited per IP. Google geocoding is roughly $5 per 1000 calls;
// the cap is what keeps a scraper from being an invoice.
const { searchPlaces, reverseGeocode, isGeocodingConfigured } = require("../../util/geo");

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.PLACES_RATE_LIMIT || 40);

// ip -> { count, resetAt }. In-process on purpose: this guards a cost, not a
// security boundary, and a restart clearing it is fine. Behind more than one
// backend instance each gets its own allowance, which is still a cap.
const hits = new Map();

// Bounded so a spray of unique IPs cannot grow the map without limit.
const MAX_TRACKED = 5000;

const clientIp = (req) =>
  // trust proxy is not set, so req.ip is the socket address in dev and the
  // proxy's in production. Either is a fine bucket key for a cost guard.
  String(req.ip || req.socket?.remoteAddress || "unknown");

function overLimit(req) {
  const now = Date.now();
  const key = clientIp(req);
  const seen = hits.get(key);

  if (seen == null || now > seen.resetAt) {
    if (hits.size >= MAX_TRACKED) {
      // Cheapest useful eviction: drop everything already expired, and if that
      // frees nothing, drop the oldest insertion.
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      if (hits.size >= MAX_TRACKED) hits.delete(hits.keys().next().value);
    }
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  seen.count += 1;
  return seen.count > MAX_PER_WINDOW;
}

// GET /admin/places/search?q=...
exports.search = async (req, res) => {
  if (!isGeocodingConfigured()) {
    // Not an error: the picker still works by dragging, it just cannot search.
    return res.json({ results: [], reason: "geocoding_not_configured" });
  }
  if (overLimit(req)) {
    return res.status(429).json({ results: [], message: "Too many searches. Try again shortly." });
  }

  const q = String(req.query.q || "").trim();
  // Two characters matches half of India; make the caller be specific rather
  // than paying Google to tell us so.
  if (q.length < 3) return res.json({ results: [] });

  const results = await searchPlaces(q);
  res.json({ results });
};

// GET /admin/places/reverse?lat=..&lng=..
// What the marker landed on, so a dragged pin gets a name rather than only
// coordinates. A null answer is fine — the picker shows the numbers.
exports.reverse = async (req, res) => {
  if (!isGeocodingConfigured()) return res.json({ place: null });
  if (overLimit(req)) {
    return res.status(429).json({ place: null, message: "Too many lookups. Try again shortly." });
  }

  const place = await reverseGeocode(req.query.lat, req.query.lng);
  res.json({ place });
};
