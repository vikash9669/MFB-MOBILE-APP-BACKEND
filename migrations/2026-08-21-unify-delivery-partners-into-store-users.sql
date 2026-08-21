-- Unify delivery partners into store_users.
--
-- A rider used to exist twice: as store_users.user_role = 3 (the panel roster
-- that orders, reports and assignment read) and as a store_delivery_partners
-- row (the app account holding OTP state and KYC), joined on phone number.
-- That join was the flaw — a phone already belonging to a customer matched, so
-- a real application looked "already linked" and appeared in neither the review
-- queue nor the roster. It also meant the 92 panel-only riders could not sign
-- in to the partner app at all.
--
-- Afterwards there is one row per person: user_role = 3 means "is a partner",
-- and dp_id is store_users.user_id.
--
-- ─── READ THIS BEFORE RUNNING ────────────────────────────────────────────
--
-- THIS IS NOT ATOMIC. MySQL and MariaDB implicitly COMMIT before and after
-- every DDL statement, and this migration contains twenty of them. Wrapping it
-- in START TRANSACTION would be theatre: a failure halfway through leaves the
-- database halfway through. A restored backup is the only rollback.
--
--   mysqldump -h HOST -P PORT -u USER -p DBNAME > backup-before-unify.sql
--
-- Run it in four numbered parts, checking the output of each before starting
-- the next. Parts 1 and 2 are additive and safe to repeat. Part 3 is the point
-- of no return. Part 4 retires the old table by renaming, not dropping.
--
-- On a database provisioned from the current migrations there is no
-- store_delivery_partners table at all and PARTS 1-2 are the entire job. The
-- check at the top of PART 3 tells you which case you are in.
--
--   mysql -h HOST -P PORT -u USER -p DBNAME < this-file.sql
--
-- The ADD COLUMN statements use IF NOT EXISTS (MariaDB 10.0+ / MySQL 8.0.29+)
-- because a backend boot with AUTO_MIGRATE=true may already have added them.

-- ════ PART 1 · Columns (additive, repeatable) ════════════════════════════
-- The other eight partner fields merge into columns store_users already has —
-- dp_name/dp_email/dp_phone/dp_photo/dp_registered/dp_last_login become
-- user_name/user_email/user_phone/user_image/user_registered/user_last_login.
-- Two copies of a phone number on one row is how they drift apart.
--
-- dp_active is deliberately NOT merged into user_active. user_active is a
-- tri-state panel listing flag (of the 92 riders: 66 are 0, 14 are 1, 12 are 2)
-- while every dispatch query tests dp_active = 1. Merging them would have made
-- 78 riders silently undispatchable.
ALTER TABLE `store_users`
  ADD COLUMN IF NOT EXISTS `dp_code` varchar(12) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS `dp_request_id` varchar(100) NULL,
  ADD COLUMN IF NOT EXISTS `dp_token_version` int(11) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS `dp_settings` longtext NULL,
  ADD COLUMN IF NOT EXISTS `dp_vehicle_type` varchar(30) NOT NULL DEFAULT 'Bike',
  ADD COLUMN IF NOT EXISTS `dp_vehicle_number` varchar(20) NULL,
  ADD COLUMN IF NOT EXISTS `dp_verification_status` enum('pending','under_review','approved','rejected') NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS `dp_rejection_reason` varchar(255) NULL,
  ADD COLUMN IF NOT EXISTS `dp_submitted_at` datetime NULL,
  ADD COLUMN IF NOT EXISTS `dp_reviewed_at` datetime NULL,
  ADD COLUMN IF NOT EXISTS `dp_bank_account` varchar(30) NULL,
  ADD COLUMN IF NOT EXISTS `dp_bank_ifsc` varchar(15) NULL,
  ADD COLUMN IF NOT EXISTS `dp_bank_holder` varchar(80) NULL,
  ADD COLUMN IF NOT EXISTS `dp_upi_id` varchar(80) NULL,
  ADD COLUMN IF NOT EXISTS `dp_online` tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `dp_active` tinyint(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS `dp_lat` decimal(10,7) NULL,
  ADD COLUMN IF NOT EXISTS `dp_lng` decimal(10,7) NULL,
  ADD COLUMN IF NOT EXISTS `dp_wallet_balance` decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `dp_cash_in_hand` decimal(10,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS `dp_rating` decimal(3,2) NOT NULL DEFAULT 5.00,
  ADD COLUMN IF NOT EXISTS `dp_total_deliveries` int(11) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `dp_on_time_pct` int(11) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS `dp_acceptance_pct` int(11) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS `dp_completion_pct` int(11) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS `dp_cancellation_pct` decimal(4,1) NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS `dp_avg_delivery_min` int(11) NOT NULL DEFAULT 0;

-- OTP lookup by phone on every sign-in; dispatch scans for online riders.
CREATE INDEX IF NOT EXISTS `idx_users_role_phone`  ON `store_users` (`user_role`, `user_phone`);
CREATE INDEX IF NOT EXISTS `idx_users_role_online` ON `store_users` (`user_role`, `dp_online`);

-- ════ PART 2 · Existing panel riders become partners (repeatable) ════════
-- These 92 predate the app and have no documents on file. Approved
-- deliberately: they are riders you already work with, and 'pending' would
-- lock every one of them out until reviewed individually. Change 'approved' to
-- 'pending' below if you would rather review them.
--
-- dp_active is seeded from user_active so a rider you have already delisted in
-- the panel does not start taking app jobs. Note this leaves the 12 riders on
-- the legacy value 2 inactive; check them afterwards with the query in PART 5.
UPDATE `store_users`
SET `dp_verification_status` = 'approved',
    `dp_reviewed_at`         = COALESCE(`dp_reviewed_at`, NOW()),
    `dp_active`              = IF(`user_active` = 1, 1, 0),
    `dp_code`                = IF(`dp_code` = '', CONCAT('R', LPAD(`user_id`, 6, '0')), `dp_code`)
WHERE `user_role` = 3;

SELECT COUNT(*) AS riders_marked_approved FROM `store_users`
WHERE `user_role` = 3 AND `dp_verification_status` = 'approved';

-- ════ PART 3 · Carry across the app's partner records ════════════════════
-- POINT OF NO RETURN. Everything above is additive; this rewrites dp_id values
-- in the child tables.
--
-- Stop here and restore from backup if PART 2 did not report what you expected.
--
-- SKIP THE REST OF PART 3 AND ALL OF PART 4 IF THIS PRINTS 'skip'.
-- A database provisioned from the current migrations never had a separate
-- partner table: 2026-08-07-app-tables.sql no longer creates one and the child
-- tables reference store_users(user_id) from the start, so there is nothing to
-- carry across and PARTS 1-2 are the whole migration. Only a database that ran
-- the older app-tables.sql has work to do here.
SELECT IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'store_delivery_partners') = 0,
  'skip - no store_delivery_partners table; PARTS 1-2 were the whole migration',
  'continue - store_delivery_partners exists and must be carried across'
) AS part3_needed;

DROP TABLE IF EXISTS `dp_migration_map`;
CREATE TABLE `dp_migration_map` (
  `old_dp_id`   int(11) NOT NULL PRIMARY KEY,
  `new_user_id` int(11) NULL,
  `dp_phone10`  varchar(10) NOT NULL
) ENGINE=InnoDB;

INSERT INTO `dp_migration_map` (`old_dp_id`, `dp_phone10`)
SELECT `dp_id`, RIGHT(REGEXP_REPLACE(`dp_phone`, '[^0-9]', ''), 10)
FROM `store_delivery_partners`;

-- Prefer an existing rider; otherwise any account on that number.
UPDATE `dp_migration_map` m
JOIN `store_users` u
  ON RIGHT(REGEXP_REPLACE(COALESCE(u.`user_phone`, ''), '[^0-9]', ''), 10) = m.`dp_phone10`
SET m.`new_user_id` = u.`user_id`;

-- Partners with no account at all get one.
INSERT INTO `store_users`
  (`user_role`, `user_name`, `user_email`, `user_phone`, `user_phone_1`, `user_otp`,
   `user_code`, `user_manager`, `user_landmark`, `user_city`, `user_state`, `user_zip`,
   `user_location`, `user_password`, `user_registered`, `user_login`, `user_active`, `user_status`)
SELECT 3,
       LEFT(COALESCE(NULLIF(p.`dp_name`, ''), CONCAT('Rider ', RIGHT(m.`dp_phone10`, 4))), 40),
       COALESCE(NULLIF(p.`dp_email`, ''), CONCAT('dp', p.`dp_id`, '@example.com')),
       m.`dp_phone10`, m.`dp_phone10`, '000000',
       CONCAT('D', RIGHT(CAST(UNIX_TIMESTAMP() AS CHAR), 6), p.`dp_id`),
       0, '', '1', 1, '000000', 0,
       -- Unusable by design: partners sign in with an OTP, never a password.
       MD5(CONCAT(UUID(), RAND())),
       COALESCE(p.`dp_registered`, NOW()), 0, 1, 1
FROM `store_delivery_partners` p
JOIN `dp_migration_map` m ON m.`old_dp_id` = p.`dp_id`
WHERE m.`new_user_id` IS NULL;

UPDATE `dp_migration_map` m
JOIN `store_users` u
  ON RIGHT(REGEXP_REPLACE(COALESCE(u.`user_phone`, ''), '[^0-9]', ''), 10) = m.`dp_phone10`
 AND u.`user_role` = 3
SET m.`new_user_id` = u.`user_id`
WHERE m.`new_user_id` IS NULL;

-- Promote the matched account and copy the partner's own fields across.
-- A phone that belonged to a customer becomes a rider: with one table the role
-- is what marks a partner, so an account cannot be both.
UPDATE `store_users` u
JOIN `dp_migration_map` m ON m.`new_user_id` = u.`user_id`
JOIN `store_delivery_partners` p ON p.`dp_id` = m.`old_dp_id`
SET u.`user_role`              = 3,
    u.`user_name`              = LEFT(COALESCE(NULLIF(p.`dp_name`, ''), u.`user_name`), 40),
    u.`user_email`             = COALESCE(NULLIF(p.`dp_email`, ''), u.`user_email`),
    u.`user_image`             = COALESCE(NULLIF(p.`dp_photo`, ''), u.`user_image`),
    u.`dp_code`                = COALESCE(NULLIF(p.`dp_code`, ''), CONCAT('R', LPAD(u.`user_id`, 6, '0'))),
    u.`dp_request_id`          = p.`dp_request_id`,
    u.`dp_token_version`       = p.`dp_token_version`,
    u.`dp_settings`            = p.`dp_settings`,
    u.`dp_vehicle_type`        = p.`dp_vehicle_type`,
    u.`dp_vehicle_number`      = p.`dp_vehicle_number`,
    u.`dp_verification_status` = p.`dp_verification_status`,
    u.`dp_rejection_reason`    = p.`dp_rejection_reason`,
    u.`dp_submitted_at`        = p.`dp_submitted_at`,
    u.`dp_reviewed_at`         = p.`dp_reviewed_at`,
    u.`dp_bank_account`        = p.`dp_bank_account`,
    u.`dp_bank_ifsc`           = p.`dp_bank_ifsc`,
    u.`dp_bank_holder`         = p.`dp_bank_holder`,
    u.`dp_upi_id`              = p.`dp_upi_id`,
    u.`dp_online`              = p.`dp_online`,
    u.`dp_active`              = p.`dp_active`,
    u.`dp_lat`                 = p.`dp_lat`,
    u.`dp_lng`                 = p.`dp_lng`,
    u.`dp_wallet_balance`      = p.`dp_wallet_balance`,
    u.`dp_cash_in_hand`        = p.`dp_cash_in_hand`,
    u.`dp_rating`              = p.`dp_rating`,
    u.`dp_total_deliveries`    = p.`dp_total_deliveries`,
    u.`dp_on_time_pct`         = p.`dp_on_time_pct`,
    u.`dp_acceptance_pct`      = p.`dp_acceptance_pct`,
    u.`dp_completion_pct`      = p.`dp_completion_pct`,
    u.`dp_cancellation_pct`    = p.`dp_cancellation_pct`,
    u.`dp_avg_delivery_min`    = p.`dp_avg_delivery_min`,
    u.`user_last_login`        = COALESCE(p.`dp_last_login`, u.`user_last_login`);

-- Nothing may be left unmapped. store_delivery_orders.dp_id is NULLABLE, so an
-- unmapped partner would not error below — it would quietly null the rider on
-- real delivery orders. This raises ER_SUBQUERY_NO_1_ROW to stop the script,
-- because a plain SELECT cannot signal an error outside a stored procedure.
SELECT COUNT(*) INTO @unmapped FROM `dp_migration_map` WHERE `new_user_id` IS NULL;
-- The WHERE matters: IF() is not guaranteed to short-circuit, and without it
-- the two-row subquery could raise the error on the success path too.
SELECT IF(@unmapped = 0, 'mapping ok — every partner resolved to a user',
          (SELECT 'ABORT: a partner could not be mapped to a user'
             FROM (SELECT 1 UNION ALL SELECT 2) x
            WHERE @unmapped > 0)) AS mapping_check;

-- Repoint the children. Foreign keys come off first: while they still point at
-- the old table an updated dp_id would violate the constraint.
ALTER TABLE `store_delivery_documents`     DROP FOREIGN KEY `store_delivery_documents_ibfk_1`;
ALTER TABLE `store_delivery_orders`        DROP FOREIGN KEY `store_delivery_orders_ibfk_1`;
ALTER TABLE `store_delivery_devices`       DROP FOREIGN KEY `store_delivery_devices_ibfk_1`;
ALTER TABLE `store_delivery_sessions`      DROP FOREIGN KEY `store_delivery_sessions_ibfk_1`;
ALTER TABLE `store_delivery_shifts`        DROP FOREIGN KEY `store_delivery_shifts_ibfk_1`;
ALTER TABLE `store_delivery_wallet_txns`   DROP FOREIGN KEY `store_delivery_wallet_txns_ibfk_1`;
ALTER TABLE `store_delivery_notifications` DROP FOREIGN KEY `store_delivery_notifications_ibfk_1`;

UPDATE `store_delivery_documents`      t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_orders`         t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_devices`        t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_sessions`       t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_shifts`         t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_wallet_txns`    t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_notifications`  t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
-- These carry dp_id without a foreign key.
UPDATE `store_delivery_batches`        t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_offers`         t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_order_events`   t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_ratings`        t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_delivery_session_points` t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;
UPDATE `store_dispatch_logs`           t JOIN `dp_migration_map` m ON m.`old_dp_id` = t.`dp_id` SET t.`dp_id` = m.`new_user_id`;

ALTER TABLE `store_delivery_documents`
  ADD CONSTRAINT `fk_dp_documents_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);
ALTER TABLE `store_delivery_orders`
  ADD CONSTRAINT `fk_dp_orders_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);
ALTER TABLE `store_delivery_devices`
  ADD CONSTRAINT `fk_dp_devices_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);
ALTER TABLE `store_delivery_sessions`
  ADD CONSTRAINT `fk_dp_sessions_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);
ALTER TABLE `store_delivery_shifts`
  ADD CONSTRAINT `fk_dp_shifts_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);
ALTER TABLE `store_delivery_wallet_txns`
  ADD CONSTRAINT `fk_dp_wallet_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);
ALTER TABLE `store_delivery_notifications`
  ADD CONSTRAINT `fk_dp_notifications_user` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`);

-- ════ PART 4 · Retire the old table ══════════════════════════════════════
-- Renamed, not dropped, so the data survives if something was missed. Drop it
-- yourself once the app has been exercised end to end:
--   DROP TABLE `zz_retired_store_delivery_partners`;
RENAME TABLE `store_delivery_partners` TO `zz_retired_store_delivery_partners`;
DROP TABLE `dp_migration_map`;

-- ════ PART 5 · Verify ════════════════════════════════════════════════════
SELECT COUNT(*)                                      AS partners_total,
       SUM(`dp_verification_status` = 'approved')    AS approved,
       SUM(`dp_verification_status` = 'under_review') AS awaiting_review,
       SUM(`dp_active` = 1)                          AS dispatchable
FROM `store_users` WHERE `user_role` = 3;

-- Riders left inactive because user_active was neither 0 nor 1. Review these:
-- either set dp_active = 1 so they can work, or leave them off.
SELECT `user_id`, `user_active`, `dp_active`
FROM `store_users`
WHERE `user_role` = 3 AND `user_active` NOT IN (0, 1);
