-- Order acceptance lifecycle: accept / decline / auto-cancel / refund.
--
-- Every column is NULLABLE with no default change, and no existing column is
-- touched, so this is additive and safe to run against a live table: existing
-- rows read as "legacy order, never went through the accept flow", which is
-- exactly what they are. The application probes for these columns at boot
-- (util/lifecycleColumns.js) and degrades cleanly if they are absent, so the
-- code can ship before the migration runs.
--
-- Run with:
--   mysql -h 127.0.0.1 -P 33061 -u <user> -p <db> < migrations/2026-08-09-order-lifecycle.sql

ALTER TABLE `store_orders`
  -- When the vendor actually accepted. Distinct from order_received_time,
  -- which is unreliable (util/orders.js writes it with a manual +5.5h IST
  -- shift, the legacy PHP panel writes real UTC). This one is always UTC_TIMESTAMP.
  ADD COLUMN IF NOT EXISTS `order_accepted_time`  DATETIME     NULL,
  -- Minutes the vendor promised for preparation, captured at accept time.
  ADD COLUMN IF NOT EXISTS `order_prep_minutes`   SMALLINT     NULL,
  -- Why an order ended at status 6, and who ended it. Free text is deliberate:
  -- a decline reason is shown to staff, not branched on.
  ADD COLUMN IF NOT EXISTS `order_cancel_reason`  VARCHAR(255) NULL,
  -- 'vendor' | 'admin' | 'system' — separates a vendor declining from the
  -- 10-minute timeout, which read identically before and made the auto-cancel
  -- rate impossible to measure.
  ADD COLUMN IF NOT EXISTS `order_cancelled_by`   VARCHAR(16)  NULL;

-- The sweeper's hot query is "unaccepted orders newer than X". Without this it
-- is a full scan of a table that only grows.
CREATE INDEX IF NOT EXISTS `order_status_id_idx` ON `store_orders` (`order_status`, `order_id`);

ALTER TABLE `store_payment_intents`
  -- PhonePe's merchantRefundId (ours) and refundId (theirs).
  ADD COLUMN IF NOT EXISTS `merchant_refund_id`   VARCHAR(64)  NULL,
  ADD COLUMN IF NOT EXISTS `provider_refund_id`   VARCHAR(64)  NULL,
  -- PENDING | COMPLETED | FAILED, mirroring PhonePe's refund states.
  ADD COLUMN IF NOT EXISTS `refund_status`        VARCHAR(16)  NULL,
  ADD COLUMN IF NOT EXISTS `refund_amount`        DECIMAL(10,2) NULL,
  ADD COLUMN IF NOT EXISTS `refunded_at`          DATETIME     NULL,
  ADD COLUMN IF NOT EXISTS `refund_failure`       VARCHAR(255) NULL;

-- Refunds are claimed by a conditional UPDATE on this column, so it must be
-- unique or a double-claim could issue two refunds for one payment.
CREATE UNIQUE INDEX IF NOT EXISTS `merchant_refund_id_idx`
  ON `store_payment_intents` (`merchant_refund_id`);
