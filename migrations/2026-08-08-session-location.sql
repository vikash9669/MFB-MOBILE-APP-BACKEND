-- Adds the device position captured when a delivery partner goes online and
-- offline, to store_delivery_sessions.
--
-- Run against the working clone, NOT the pristine snapshot:
--   mysql -h 127.0.0.1 -P 33061 -u mfb_dev -p mfb_app_dev < this file
--
-- All four columns are nullable on purpose: location permission can be denied
-- and a GPS fix can time out, and a session must still be recorded when that
-- happens. The times are the point; the coordinates are supporting evidence.

ALTER TABLE store_delivery_sessions
  ADD COLUMN start_lat DECIMAL(10,7) NULL AFTER duration_min,
  ADD COLUMN start_lng DECIMAL(10,7) NULL AFTER start_lat,
  ADD COLUMN end_lat   DECIMAL(10,7) NULL AFTER start_lng,
  ADD COLUMN end_lng   DECIMAL(10,7) NULL AFTER end_lat;
