// Geocoding + distance helpers.
//
// Neither end of a delivery has coordinates stored. Customer addresses live in
// store_users_shipping_address as free text with no lat/lng columns, and a
// restaurant's address sits on its store_users row. So the only way to put
// either on a map is to geocode when we build the delivery job.
//
// Results are cached in-process because the same handful of restaurants and the
// same repeat-customer addresses come round constantly, and every lookup is
// billable. The cache is deliberately not persisted — a restart costs a few
// cheap lookups, which is a better trade than a schema change.
//
// Everything here fails soft. No GOOGLE_MAPS_API_KEY, an API error, or an
// address Google can't place all return null, which leaves the job's lat/lng
// NULL. The rider still gets the order, just without a pin.
const axios = require("axios");

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const CACHE_MAX = 500;
const cache = new Map();

const apiKey = () => process.env.GOOGLE_MAPS_API_KEY || "";

// Whether geocoding can run at all. Used by the dispatch logging so a missing
// key reads as a setup gap rather than a string of failed lookups.
const isGeocodingConfigured = () => !!apiKey();

// Joins address fragments into one query string, dropping blanks and repeats
// (landmark and address often duplicate the locality).
const buildQuery = (parts) => {
  const seen = new Set();
  parts
    .filter((p) => p != null && String(p).trim() !== "")
    .map((p) => String(p).trim())
    .forEach((p) => seen.add(p));
  return [...seen].join(", ");
};

const remember = (cacheKey, value) => {
  if (cache.size >= CACHE_MAX) {
    // Plain FIFO eviction — good enough for a few hundred hot addresses.
    cache.delete(cache.keys().next().value);
  }
  cache.set(cacheKey, value);
};

// One request. Returns { lat, lng }, or null when Google can't place it.
async function lookup(query, components) {
  const { data } = await axios.get(GEOCODE_URL, {
    params: { address: query, key: apiKey(), region: "in", components },
    timeout: 8000,
  });

  if (data?.status !== "OK" && data?.status !== "ZERO_RESULTS") {
    // REQUEST_DENIED / OVER_QUERY_LIMIT are configuration or billing problems
    // worth seeing in the logs — they won't fix themselves on retry.
    console.log(
      "MFB-error-logs ~ geocode ~ status:",
      data?.status,
      data?.error_message || ""
    );
  }

  const loc = data?.results?.[0]?.geometry?.location;
  return loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
    ? { lat: loc.lat, lng: loc.lng }
    : null;
}

// Resolves address fragments to { lat, lng }, or null when it can't.
//
// A postal_code components filter is tried first — it's what stops Google
// returning the wrong "MG Road" from three states away. But that filter is
// strict, and plenty of real Indian addresses fail it outright: a pincode that
// disagrees with the street text, or simply isn't indexed as a postal_code,
// yields ZERO_RESULTS even when the address is perfectly findable. So a miss
// falls back to an unfiltered, country-scoped lookup rather than giving up.
async function geocode(parts, { pincode } = {}) {
  const query = buildQuery(parts);
  if (query === "" || !apiKey()) {
    return null;
  }

  const cacheKey = `${query}|${pincode || ""}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    let result = null;
    if (pincode) {
      result = await lookup(query, `country:IN|postal_code:${pincode}`);
    }
    if (result == null) {
      result = await lookup(query, "country:IN");
    }

    // Misses are cached too: an address Google can't place won't become
    // placeable on the next order, and re-asking just costs money.
    remember(cacheKey, result);
    return result;
  } catch (err) {
    // Transient (timeout, network) — deliberately not cached, so it retries.
    console.log("MFB-error-logs ~ geocode ~ err:", err.message);
    return null;
  }
}

const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance in km between two { lat, lng } points.
function haversineKm(a, b) {
  if (a?.lat == null || a?.lng == null || b?.lat == null || b?.lng == null) {
    return null;
  }
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Straight-line distance under-reads what a rider actually covers, so pad it.
// This is a heuristic, not a Directions API call — see DELIVERY_DISPATCH.md for
// why we don't route here.
const ROAD_FACTOR = 1.3;

function roadDistanceKm(a, b) {
  const straight = haversineKm(a, b);
  return straight == null ? null : Math.round(straight * ROAD_FACTOR * 10) / 10;
}

const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";

// Road routes are cached briefly: a rider's screen re-fetches on focus and on
// every leg change, and the road between two fixed points does not move. Keyed
// coarsely (4dp ≈ 11m) so tiny GPS jitter doesn't miss the cache.
const routeCache = new Map();
const ROUTE_CACHE_MAX = 200;
const ROUTE_TTL_MS = 5 * 60_000;

const routeKey = (a, b, mode) =>
  `${a.lat.toFixed(4)},${a.lng.toFixed(4)}|${b.lat.toFixed(4)},${b.lng.toFixed(4)}|${mode}`;

/**
 * The actual road route between two points.
 *
 * Returns Google's encoded polyline plus the real driving distance and time.
 * `roadDistanceKm` above is a straight-line estimate padded by a constant — fine
 * for ranking riders, useless for drawing a line on a map, which is why the
 * partner app drew a dotted straight line through buildings.
 *
 * Returns null when the key is missing or Google has no route, so callers fall
 * back to the straight line rather than showing nothing.
 *
 * NOTE: this needs the *Directions API* enabled on the key — it is a separate
 * product from Geocoding and Places, and a key with only those returns
 * REQUEST_DENIED.
 */
async function directions(from, to, mode = "driving") {
  if (!apiKey() || from == null || to == null) return null;

  const key = routeKey(from, to, mode);
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.value;

  try {
    const { data } = await axios.get(DIRECTIONS_URL, {
      params: {
        origin: `${from.lat},${from.lng}`,
        destination: `${to.lat},${to.lng}`,
        mode,
        key: apiKey(),
        // Two-wheelers are the fleet; this is the closest Google offers and it
        // keeps riders off routes they cannot legally take.
        alternatives: false,
      },
      timeout: 8000,
    });

    if (data?.status !== "OK" || !data.routes?.length) {
      // Log the status once — REQUEST_DENIED here almost always means the
      // Directions API is not enabled on the key, which is worth saying out
      // loud rather than silently drawing straight lines forever.
      console.log(
        `MFB ~ directions ~ ${data?.status}: ${data?.error_message || "no route"}`
      );
      return null;
    }

    const route = data.routes[0];
    const leg = route.legs?.[0];
    const value = {
      polyline: route.overview_polyline?.points ?? null,
      distance_km: leg?.distance?.value ? Math.round((leg.distance.value / 1000) * 10) / 10 : null,
      duration_min: leg?.duration?.value ? Math.round(leg.duration.value / 60) : null,
    };

    if (routeCache.size >= ROUTE_CACHE_MAX) {
      routeCache.delete(routeCache.keys().next().value);
    }
    routeCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.log("MFB ~ directions ~ err:", err.message);
    return null;
  }
}

/**
 * Address search for a human picking a spot on a map — several candidates with
 * their names, not one bare coordinate.
 *
 * This exists so the panel's map picker never needs a browser-side Google key.
 * The web Maps JS API would require its own referrer-restricted key, which does
 * not exist yet (see MFB-ADMIN-PANEL/src/panel/components/AddressMap.tsx), and
 * shipping the server key to a browser is not an option — it is unrestricted
 * and billable by anyone who reads the page source. So the browser draws an
 * OpenStreetMap tile map and asks *us* to resolve text, and the key stays here.
 *
 * Deliberately not cached: `geocode` caches because dispatch asks the same
 * handful of addresses forever, whereas this is a person typing, where a stale
 * answer to a half-typed query is worse than a fresh lookup.
 *
 * Returns [] rather than throwing on any failure — a search box that breaks the
 * page is worse than one that finds nothing, and the operator can still drag
 * the marker by hand.
 */
async function searchPlaces(query, { limit = 5 } = {}) {
  const q = String(query || "").trim();
  if (q === "" || !apiKey()) return [];

  try {
    const { data } = await axios.get(GEOCODE_URL, {
      params: { address: q, key: apiKey(), region: "in", components: "country:IN" },
      timeout: 8000,
    });

    if (data?.status !== "OK" && data?.status !== "ZERO_RESULTS") {
      console.log(
        "MFB-error-logs ~ place search ~ status:",
        data?.status,
        data?.error_message || ""
      );
      return [];
    }

    return (data.results || [])
      .slice(0, limit)
      .map((r) => ({
        formatted: r.formatted_address ?? null,
        place_id: r.place_id ?? null,
        lat: r.geometry?.location?.lat ?? null,
        lng: r.geometry?.location?.lng ?? null,
      }))
      .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch (err) {
    console.log("MFB-error-logs ~ place search ~ err:", err.message);
    return [];
  }
}

/**
 * The address at a point — what the marker landed on after a drag.
 *
 * Same no-browser-key reasoning as searchPlaces. Returns null when there is
 * nothing to say, which the picker renders as bare coordinates; a pin with no
 * label is still a perfectly good pin.
 */
async function reverseGeocode(lat, lng) {
  if (!apiKey()) return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

  try {
    const { data } = await axios.get(GEOCODE_URL, {
      params: { latlng: `${latNum},${lngNum}`, key: apiKey(), region: "in" },
      timeout: 8000,
    });
    const first = data?.results?.[0];
    if (first == null) return null;
    return {
      formatted: first.formatted_address ?? null,
      place_id: first.place_id ?? null,
    };
  } catch (err) {
    console.log("MFB-error-logs ~ reverse geocode ~ err:", err.message);
    return null;
  }
}

module.exports = {
  geocode,
  searchPlaces,
  reverseGeocode,
  haversineKm,
  roadDistanceKm,
  directions,
  isGeocodingConfigured,
};
