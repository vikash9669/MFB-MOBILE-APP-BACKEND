-- Doorstep online collection: a COD order paid by UPI/card at the door.
--
-- Reuses store_payment_intents rather than adding a table, so the webhook,
-- the status poll and the reconciliation sweeper keep working unchanged —
-- all three already re-verify against PhonePe's status API, and that is the
-- part that must not be duplicated for a second payment type.
--
-- Additive and nullable. Existing rows read as purpose='checkout', which is
-- what they are. util/collectionColumns.js probes for these and the feature
-- stays off until the migration runs.
--
-- Run with:
--   mysql -h 127.0.0.1 -P 33061 -u <user> -p <db> < migrations/2026-08-12-cod-online-collection.sql

ALTER TABLE `store_payment_intents`
  -- 'checkout'       — paid up-front in the app or storefront (the original flow)
  -- 'cod_collection' — a COD order converted to online at the doorstep
  --
  -- Nullable rather than DEFAULT 'checkout': a NULL on an existing row is
  -- honest about never having been classified, and the code treats
  -- NULL and 'checkout' identically.
  ADD COLUMN `purpose` VARCHAR(16) NULL,

  -- The delivery job the money was collected against. Null for checkout
  -- intents, which exist before any delivery job does.
  ADD COLUMN `do_id` INT NULL,

  -- Which rider was standing there. Recorded for disputes ("the customer says
  -- they paid") and to measure who is actually offering the option.
  ADD COLUMN `collected_by_dp_id` INT NULL,

  -- Where the customer is sent to pay. Cached so re-opening the screen shows
  -- the same QR instead of minting a second payment for one order.
  ADD COLUMN `collect_url` VARCHAR(1000) NULL,

  -- PhonePe expires its checkout; past this the QR is dead and a new intent
  -- must be created.
  ADD COLUMN `expires_at` DATETIME NULL;

-- The hot lookup is "is there a live collection intent for this job?".
CREATE INDEX `intent_collection_idx`
  ON `store_payment_intents` (`do_id`, `purpose`, `status`);
