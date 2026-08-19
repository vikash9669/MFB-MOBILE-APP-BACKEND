// Google Places / reverse geocoding, proxied.
//
// The app needs three things to run an address picker: search suggestions, the
// coordinates behind a chosen suggestion, and the address behind a dropped pin.
// All three could be called straight from the device — and that is exactly the
// mistake worth avoiding, because a Places key in a JS bundle is a key anyone
// can pull out of the APK and spend. The Maps *SDK* key in the native manifest
// is unavoidable and is restricted by package name and signing certificate;
// these web-service calls have no such restriction, so they stay here.
//
// Everything is scoped to India and biased to the customer's viewport, and
// every response is small and flat — the app never sees a raw Google payload.
const axios = require("axios");
const { isGeocodingConfigured } = require("../util/geo");

const AUTOCOMPLETE_URL =
  "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";
const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

const key = () => process.env.GOOGLE_MAPS_API_KEY || "";

// Autocomplete bills per keystroke-ish request, so a session token groups the
// keystrokes of one search with the details call that follows into a single
// billable session. The app generates it and passes it through.
const sessionToken = (req) => req.query.session || undefined;

const notConfigured = (res) =>
  res.status(503).json({
    message:
      "Address search is unavailable. Set GOOGLE_MAPS_API_KEY in the backend .env.",
  });

// Pulls the bits of a geocoder result the app actually renders.
const parseComponents = (components = []) => {
  const find = (type) =>
    components.find((c) => c.types.includes(type))?.long_name || null;
  return {
    pincode: find("postal_code"),
    // Google's locality is often missing in smaller Indian towns; the
    // administrative levels below it are the usable fallback.
    city:
      find("locality") ||
      find("administrative_area_level_3") ||
      find("administrative_area_level_2"),
    state: find("administrative_area_level_1"),
    // The most specific named thing at the pin — what a rider recognises.
    area:
      find("sublocality_level_1") ||
      find("sublocality") ||
      find("neighborhood") ||
      find("route"),
  };
};

// GET /places/autocomplete?q=&lat=&lng=&session=
// Suggestions for what the customer is typing.
exports.autocomplete = async (req, res) => {
  if (!isGeocodingConfigured()) return notConfigured(res);

  const q = String(req.query.q || "").trim();
  // One or two characters match half of India and cost a request to prove it.
  if (q.length < 3) return res.json({ predictions: [] });

  try {
    const params = {
      input: q,
      key: key(),
      components: "country:in",
      sessiontoken: sessionToken(req),
    };

    // Bias toward where the customer actually is, so "MG Road" resolves to the
    // one down the street rather than the one in another state.
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      params.location = `${lat},${lng}`;
      params.radius = 30000;
    }

    const { data } = await axios.get(AUTOCOMPLETE_URL, { params, timeout: 8000 });

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.log(
        "MFB-error-logs ~ places autocomplete ~ status:",
        data.status,
        data.error_message || ""
      );
    }

    res.json({
      predictions: (data.predictions || []).slice(0, 8).map((p) => ({
        place_id: p.place_id,
        title: p.structured_formatting?.main_text || p.description,
        subtitle: p.structured_formatting?.secondary_text || "",
      })),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ places autocomplete ~ err:", err.message);
    // A failed search must not block the picker — the customer can still drag
    // the pin, which is the primary interaction anyway.
    res.json({ predictions: [] });
  }
};

// GET /places/details?place_id=&session=
// The coordinates and address behind a chosen suggestion.
exports.details = async (req, res) => {
  if (!isGeocodingConfigured()) return notConfigured(res);

  const placeId = String(req.query.place_id || "").trim();
  if (placeId === "") {
    return res.status(400).json({ message: "place_id is required" });
  }

  try {
    const { data } = await axios.get(DETAILS_URL, {
      params: {
        place_id: placeId,
        key: key(),
        fields: "geometry,formatted_address,name,address_component",
        sessiontoken: sessionToken(req),
      },
      timeout: 8000,
    });

    const result = data.result;
    const loc = result?.geometry?.location;
    if (loc == null) {
      return res.status(404).json({ message: "Could not locate that place" });
    }

    res.json({
      lat: loc.lat,
      lng: loc.lng,
      name: result.name || null,
      formatted: result.formatted_address || null,
      place_id: placeId,
      ...parseComponents(result.address_components),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ places details ~ err:", err.message);
    res.status(502).json({ message: "Could not locate that place" });
  }
};

// GET /places/reverse?lat=&lng=
// The address under the pin. Called every time the map settles, so it is kept
// deliberately cheap and always answers with something usable.
exports.reverse = async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ message: "lat and lng are required" });
  }

  // No key still returns coordinates, so the picker keeps working and the
  // customer just types the street line themselves.
  if (!isGeocodingConfigured()) {
    return res.json({ lat, lng, formatted: null, address: null });
  }

  try {
    const { data } = await axios.get(GEOCODE_URL, {
      params: { latlng: `${lat},${lng}`, key: key(), region: "in" },
      timeout: 8000,
    });

    const result = data.results?.[0];
    if (result == null) {
      return res.json({ lat, lng, formatted: null, address: null });
    }

    const parts = parseComponents(result.address_components);
    res.json({
      lat,
      lng,
      formatted: result.formatted_address || null,
      // The street line, without the country and pincode tail that Google
      // appends — that part is noise in an address form.
      address:
        result.formatted_address?.split(",").slice(0, 3).join(",").trim() ||
        null,
      place_id: result.place_id || null,
      ...parts,
    });
  } catch (err) {
    console.log("MFB-error-logs ~ places reverse ~ err:", err.message);
    res.json({ lat, lng, formatted: null, address: null });
  }
};
