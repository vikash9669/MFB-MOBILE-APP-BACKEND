-- Map-picked delivery addresses.
--
-- store_users_shipping_address has always been free text: a street line, a
-- landmark and a store_locations id. Nothing in it can be put on a map, which
-- is why util/geo.js has to guess the customer's position by geocoding that
-- text every time a delivery job is built — slow, billable, and wrong often
-- enough to matter on a doorstep.
--
-- These columns hold what the customer actually pinned, so the coordinates are
-- the customer's answer rather than our guess.
--
-- Every column is NULLable and nothing reads them unconditionally: addresses
-- saved before this ran keep working exactly as they do now, and the backend
-- detects at boot whether these columns exist (util/addressColumns.js) so the
-- app does not break if this file has not been applied yet.
--
-- Safe to run on a live table: ADD COLUMN only, no rewrite of existing values,
-- no constraint that existing rows could violate.
--
--   mysql -h 127.0.0.1 -P 33061 -u mfb_dev -p mfb_app_dev < migrations/2026-08-08-address-geo.sql

ALTER TABLE store_users_shipping_address
  -- The pin. DECIMAL(10,7) gives ~1cm resolution, which is far more than a
  -- doorstep needs and matches store_delivery_orders' pickup/drop columns.
  ADD COLUMN delivery_lat DECIMAL(10, 7) NULL AFTER delivery_address,
  ADD COLUMN delivery_lng DECIMAL(10, 7) NULL AFTER delivery_lat,
  -- Flat / house / floor / building. Kept apart from delivery_address because
  -- the map fills in the street line and only the customer knows this part.
  ADD COLUMN delivery_house VARCHAR(255) NULL AFTER delivery_lng,
  -- "Home" | "Work" | "Other" — what the saved-address list shows as a chip.
  ADD COLUMN delivery_label VARCHAR(20) NULL AFTER delivery_house,
  -- Google's own formatted_address for the pin, kept verbatim. Useful when the
  -- customer has edited delivery_address into something only they understand
  -- and a rider needs the canonical version.
  ADD COLUMN delivery_formatted VARCHAR(500) NULL AFTER delivery_label,
  -- Google place id, when the address came from a search result rather than a
  -- dragged pin. Lets us re-resolve an address later without a fresh geocode.
  ADD COLUMN delivery_place_id VARCHAR(255) NULL AFTER delivery_formatted;

-- Lets the panel and any future "orders near X" query filter on a bounding box
-- before doing distance maths.
CREATE INDEX addr_latlng_idx ON store_users_shipping_address (delivery_lat, delivery_lng);
