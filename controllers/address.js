const { Op } = require("sequelize");
const { Location, Address } = require("../models");
const {
  geoReady,
  addressAttributes,
  writableFields,
  stripGeo,
} = require("../util/addressColumns");

// Defaults the table has always been given for fields the app never collected.
// 312601 / 29 is Nimbahera, Rajasthan — the original single-city assumption.
// The map picker returns a real pincode, so these are now only a fallback.
const DEFAULT_PIN = "312601";
const DEFAULT_STATE = 29;

const LABELS = new Set(["Home", "Work", "Other"]);

// Anything the customer typed that isn't one of the three known labels is kept
// as "Other" rather than rejected — the label is a chip, not a constraint.
const normaliseLabel = (label) => {
  if (label == null) return null;
  return LABELS.has(label) ? label : "Other";
};

// A coordinate is only worth storing if it is a real point on Earth. A bad one
// is worse than none: it puts a rider confidently in the wrong place.
const coord = (value, limit) => {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

const text = (value, max) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s.slice(0, max);
};

/**
 * delivery_city and delivery_state are INTEGER foreign keys into store_locations,
 * not names — a fact easy to miss because every other address field is text.
 *
 * Passing a name straight through reached MySQL as `Incorrect integer value:
 * 'Nimbahera' for column 'delivery_city'`, which failed the save AND echoed the
 * raw database error, column name and all, back to the client. Coerce here and
 * fall back to the default rather than letting the driver decide.
 */
const locationId = (value, fallback) => {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

/**
 * Builds the writable columns from a request body.
 *
 * The pin is all-or-nothing: half a coordinate is meaningless, so if either
 * side fails validation both are dropped and the address simply has no pin.
 */
const fromBody = (body) => {
  const lat = coord(body.delivery_lat, 90);
  const lng = coord(body.delivery_lng, 180);
  const hasPin = lat !== null && lng !== null;
  const label = text(body.delivery_label, 20);

  return {
    delivery_address: text(body.delivery_address, 255),
    delivery_landmark: text(body.delivery_landmark, 255),
    delivery_phone: text(body.delivery_phone, 13),
    // No default: several areas share pincode 312601, so guessing one would
    // quietly file the order under the wrong delivery zone. null falls through
    // to the "Please choose a delivery area" check below.
    delivery_city: locationId(body.delivery_city, null),
    delivery_pin: text(body.delivery_pin, 6) || DEFAULT_PIN,
    delivery_state: locationId(body.delivery_state, DEFAULT_STATE),
    delivery_lat: hasPin ? lat : null,
    delivery_lng: hasPin ? lng : null,
    delivery_house: text(body.delivery_house, 255),
    delivery_label: normaliseLabel(label),
    delivery_formatted: text(body.delivery_formatted, 500),
    delivery_place_id: text(body.delivery_place_id, 255),
  };
};

/** Reads an address row back with only the columns that exist. */
const findOne = async (delivery_id) =>
  Address.findOne({
    where: { delivery_id },
    attributes: await addressAttributes(),
    include: [{ model: Location, as: "location" }],
  });

const createAddress = async (req, res) => {
  try {
    const data = await stripGeo({
      ...fromBody(req.body),
      customer_id: req.user.user_id,
      delivery_status: 1,
    });

    // delivery_address and delivery_landmark are NOT NULL in the schema, and
    // the map may legitimately produce a street line with no landmark.
    if (data.delivery_address == null) {
      return res.status(400).json({ error: "An address line is required" });
    }
    if (data.delivery_landmark == null) data.delivery_landmark = "";
    if (data.delivery_phone == null) {
      return res.status(400).json({ error: "A contact number is required" });
    }
    if (data.delivery_city == null) {
      return res.status(400).json({ error: "Please choose a delivery area" });
    }

    // Naming the fields explicitly stops Sequelize inferring them from the
    // model and writing a column the database may not have.
    const address = await Address.create(data, {
      fields: await writableFields(data),
    });

    res.status(201).json(await findOne(address.delivery_id));
  } catch (error) {
    // Log the detail, return a generic message: a Sequelize error carries the
    // failing SQL, column names and types, and this endpoint is reachable by
    // any signed-in customer.
    console.log("MFB-error-logs ~ createAddress ~ err:", error.message);
    res.status(400).json({ error: "Could not save this address" });
  }
};

const findAllByUser = async (req, res) => {
  try {
    const addresses = await Address.findAll({
      where: { customer_id: req.user.user_id },
      attributes: await addressAttributes(),
      include: [{ model: Location, as: "location" }],
    });
    res.status(200).json(addresses);
  } catch (error) {
    console.log("MFB-error-logs ~ findAllByUser ~ err:", error.message);
    res.status(400).json({ error: "Could not load addresses" });
  }
};

const updateAddress = async (req, res) => {
  const { delivery_id } = req.params;

  try {
    const address = await Address.findByPk(delivery_id, {
      attributes: await addressAttributes(),
    });

    if (!address) {
      return res.status(404).json({ error: "Address not found" });
    }
    // Addresses are per-customer; without this any signed-in user could edit
    // anyone else's by guessing an id.
    if (address.customer_id !== req.user.user_id) {
      return res.status(403).json({ error: "Not your address" });
    }

    const incoming = await stripGeo(fromBody(req.body));

    // Only overwrite what was actually sent, so a partial edit — say, changing
    // just the label — cannot blank out the pin.
    const patch = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (req.body[key] !== undefined && value !== null) patch[key] = value;
    }
    // Moving the pin is the one edit that must be able to travel as a pair.
    if (req.body.delivery_lat !== undefined && (await geoReady())) {
      patch.delivery_lat = incoming.delivery_lat;
      patch.delivery_lng = incoming.delivery_lng;
    }
    if (req.body.delivery_status !== undefined) {
      patch.delivery_status = req.body.delivery_status;
    }

    await address.update(patch, { fields: await writableFields(patch) });

    res.status(200).json({
      message: "Address updated successfully",
      address: await findOne(delivery_id),
    });
  } catch (error) {
    console.log("MFB-error-logs ~ updateAddress ~ err:", error.message);
    res
      .status(500)
      .json({ error: "An error occurred while updating the address" });
  }
};

const deleteAddress = async (req, res) => {
  const { delivery_id } = req.params;

  try {
    // Scoped to the caller for the same reason update is.
    const removed = await Address.destroy({
      where: { delivery_id, customer_id: req.user.user_id },
    });

    if (removed === 0) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.status(200).json({ message: "Address deleted successfully" });
  } catch (error) {
    console.log("MFB-error-logs ~ deleteAddress ~ err:", error.message);
    res
      .status(500)
      .json({ error: "An error occurred while deleting the address" });
  }
};

const getAllLocations = async (req, res) => {
  try {
    const locations = await Location.findAll({
      where: {
        location_pincode: {
          [Op.not]: "000000",
        },
      },
    });
    res.json(locations);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching the locations" });
  }
};

module.exports = {
  createAddress,
  findAllByUser,
  updateAddress,
  deleteAddress,
  getAllLocations,
};
