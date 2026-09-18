// The complete app schema, as DDL.
//
// GENERATED from the difference between the legacy snapshot (mfb_legacy_dev,
// the shape a fresh production database arrives in) and a fully migrated
// database. Regenerate with scripts/dump-schema.js after adding a table or a
// column, and commit the result.
//
// WHY THIS SHAPE AND NOT A NUMBERED MIGRATION LEDGER
//
// A ledger records "migration 7 ran". It is the right tool when steps must
// happen in order and each one transforms the last. Nothing here does: every
// statement below is additive and independent, so what matters is not which
// migrations ran but whether the table or column is *present*. Asking the
// database directly is both simpler and self-healing — it fixes a database
// that was hand-edited, half-migrated, or restored from a snapshot taken
// mid-way, none of which a ledger can recover from on its own.
//
// EVERY STATEMENT MUST BE ADDITIVE. This file runs automatically at boot
// against production. CREATE TABLE IF NOT EXISTS and ADD COLUMN are safe on a
// live database; DROP, RENAME and MODIFY are not, and must never appear here.
// A column whose type needs to change is a hand-run migration, not this.

/**
 * Tables that do not exist in the legacy schema at all.
 *
 * ORDERED BY FOREIGN-KEY DEPENDENCY, NOT ALPHABETICALLY. Thirteen of these
 * carry named FK constraints, and MySQL refuses a REFERENCES clause pointing
 * at a table that does not exist yet. The first generated version of this file
 * was alphabetical, which meant six tables — everything referencing
 * store_delivery_partners or store_delivery_orders — failed on a fresh
 * database while the other twelve succeeded, leaving it half built.
 *
 * If you add a table, place it after anything it references.
 */
const TABLES = [
  {
    name: "store_delivery_batches",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_batches\` (
  \`batch_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int DEFAULT NULL,
  \`state\` varchar(12) NOT NULL DEFAULT 'open',
  \`orders_count\` smallint NOT NULL DEFAULT '0',
  \`total_km\` decimal(6,2) DEFAULT NULL,
  \`created_at\` datetime NOT NULL,
  \`assigned_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`batch_id\`),
  KEY \`batch_rider_idx\` (\`dp_id\`,\`state\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  },
  {
    name: "store_delivery_offers",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_offers\` (
  \`offer_id\` int NOT NULL AUTO_INCREMENT,
  \`do_id\` int NOT NULL,
  \`dp_id\` int NOT NULL,
  \`state\` varchar(12) NOT NULL DEFAULT 'pending',
  \`round\` smallint NOT NULL DEFAULT '1',
  \`score\` decimal(6,3) DEFAULT NULL,
  \`score_parts\` varchar(500) DEFAULT NULL,
  \`distance_km\` decimal(6,2) DEFAULT NULL,
  \`eta_min\` smallint DEFAULT NULL,
  \`offered_at\` datetime NOT NULL,
  \`expires_at\` datetime NOT NULL,
  \`responded_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`offer_id\`),
  UNIQUE KEY \`offer_job_rider_idx\` (\`do_id\`,\`dp_id\`),
  KEY \`offer_live_idx\` (\`state\`,\`expires_at\`),
  KEY \`offer_rider_idx\` (\`dp_id\`,\`state\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  },
  {
    name: "store_delivery_ratings",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_ratings\` (
  \`rating_id\` int NOT NULL AUTO_INCREMENT,
  \`do_id\` int NOT NULL,
  \`dp_id\` int NOT NULL,
  \`source_order_id\` int DEFAULT NULL,
  \`customer_id\` int DEFAULT NULL,
  \`stars\` tinyint(1) NOT NULL,
  \`tags\` varchar(255) DEFAULT NULL,
  \`comment\` varchar(500) DEFAULT NULL,
  \`created_at\` datetime NOT NULL,
  \`updated_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`rating_id\`),
  UNIQUE KEY \`dr_do_unique\` (\`do_id\`),
  KEY \`dr_dp_idx\` (\`dp_id\`),
  KEY \`dr_created_idx\` (\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  },
  {
    name: "store_dispatch_logs",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_dispatch_logs\` (
  \`log_id\` int NOT NULL AUTO_INCREMENT,
  \`do_id\` int NOT NULL,
  \`dp_id\` int DEFAULT NULL,
  \`event\` varchar(20) NOT NULL,
  \`radius_km\` decimal(5,2) DEFAULT NULL,
  \`candidates\` smallint DEFAULT NULL,
  \`detail\` varchar(500) DEFAULT NULL,
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`log_id\`),
  KEY \`dispatch_log_job_idx\` (\`do_id\`,\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  },
  {
    name: "store_orders_log",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_orders_log\` (
  \`log_id\` int NOT NULL AUTO_INCREMENT,
  \`order_id\` int NOT NULL,
  \`user_id\` int NOT NULL,
  \`order_status\` int NOT NULL,
  \`createdAt\` datetime NOT NULL,
  \`updatedAt\` datetime NOT NULL,
  PRIMARY KEY (\`log_id\`),
  KEY \`fk_log_order_id\` (\`order_id\`) USING BTREE,
  KEY \`fk_log_user_id\` (\`user_id\`) USING BTREE,
  CONSTRAINT \`store_orders_log_ibfk_1\` FOREIGN KEY (\`order_id\`) REFERENCES \`store_orders\` (\`order_id\`) ON UPDATE CASCADE,
  CONSTRAINT \`store_orders_log_ibfk_2\` FOREIGN KEY (\`user_id\`) REFERENCES \`store_users\` (\`user_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_payment_intents",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_payment_intents\` (
  \`pi_id\` int NOT NULL AUTO_INCREMENT,
  \`merchant_txn_id\` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`customer_id\` int NOT NULL,
  \`vendor_id\` int NOT NULL,
  \`address_id\` int NOT NULL,
  \`amount\` int NOT NULL,
  \`cart_snapshot\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`method\` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'UPI',
  \`status\` enum('PENDING','PAID','FAILED') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'PENDING',
  \`provider_txn_id\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`order_id\` int DEFAULT NULL,
  \`failure_reason\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`createdAt\` datetime NOT NULL,
  \`updatedAt\` datetime NOT NULL,
  \`merchant_refund_id\` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`provider_refund_id\` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`refund_status\` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`refund_amount\` decimal(10,2) DEFAULT NULL,
  \`refunded_at\` datetime DEFAULT NULL,
  \`refund_failure\` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`purpose\` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`do_id\` int DEFAULT NULL,
  \`collected_by_dp_id\` int DEFAULT NULL,
  \`collect_url\` varchar(1000) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`expires_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`pi_id\`),
  UNIQUE KEY \`merchant_txn_id\` (\`merchant_txn_id\`),
  UNIQUE KEY \`merchant_refund_id_idx\` (\`merchant_refund_id\`),
  KEY \`pi_customer_id\` (\`customer_id\`) USING BTREE,
  KEY \`intent_collection_idx\` (\`do_id\`,\`purpose\`,\`status\`),
  CONSTRAINT \`store_payment_intents_ibfk_1\` FOREIGN KEY (\`customer_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_user_devices",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_user_devices\` (
  \`device_id\` int NOT NULL AUTO_INCREMENT,
  \`user_id\` int NOT NULL,
  \`token\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`platform\` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'android',
  \`created_at\` datetime NOT NULL,
  \`last_seen\` datetime NOT NULL,
  PRIMARY KEY (\`device_id\`),
  UNIQUE KEY \`ud_token_uniq\` (\`token\`) USING BTREE,
  KEY \`ud_user_idx\` (\`user_id\`) USING BTREE,
  CONSTRAINT \`store_user_devices_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_user_notifications",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_user_notifications\` (
  \`notif_id\` int NOT NULL AUTO_INCREMENT,
  \`user_id\` int NOT NULL,
  \`category\` enum('orders','offers','wallet','system') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'system',
  \`icon\` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`title\` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`body\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`ref_order_id\` int DEFAULT NULL,
  \`ref_partner_id\` int DEFAULT NULL,
  \`is_read\` tinyint(1) NOT NULL DEFAULT '0',
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`notif_id\`),
  KEY \`un_user_idx\` (\`user_id\`) USING BTREE,
  CONSTRAINT \`store_user_notifications_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_devices",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_devices\` (
  \`device_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`token\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`platform\` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'android',
  \`created_at\` datetime NOT NULL,
  \`last_seen\` datetime NOT NULL,
  PRIMARY KEY (\`device_id\`),
  UNIQUE KEY \`dd_token_uniq\` (\`token\`) USING BTREE,
  KEY \`dd_partner_idx\` (\`dp_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_devices_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_documents",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_documents\` (
  \`doc_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`doc_type\` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`title\` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`status\` enum('active','expiring','pending','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  \`expires_on\` date DEFAULT NULL,
  \`file_url\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  \`updated_at\` datetime NOT NULL,
  PRIMARY KEY (\`doc_id\`),
  KEY \`dd_partner_idx\` (\`dp_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_documents_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_notifications",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_notifications\` (
  \`notif_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`category\` enum('orders','payments','bonuses','system') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'system',
  \`icon\` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`title\` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`body\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`is_read\` tinyint(1) NOT NULL DEFAULT '0',
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`notif_id\`),
  KEY \`dn_partner_idx\` (\`dp_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_notifications_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_orders",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_orders\` (
  \`do_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int DEFAULT NULL,
  \`source_order_id\` int DEFAULT NULL,
  \`order_ref\` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`status\` enum('offered','accepted','picked_up','delivered','cancelled','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'offered',
  \`pickup_name\` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`pickup_address\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`pickup_area\` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`pickup_phone\` varchar(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`pickup_lat\` decimal(10,7) DEFAULT NULL,
  \`pickup_lng\` decimal(10,7) DEFAULT NULL,
  \`pickup_otp\` varchar(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`pickup_distance_km\` decimal(5,1) DEFAULT NULL,
  \`ready_in_min\` int DEFAULT '4',
  \`drop_name\` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`drop_address\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`drop_area\` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`drop_phone\` varchar(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`drop_lat\` decimal(10,7) DEFAULT NULL,
  \`drop_lng\` decimal(10,7) DEFAULT NULL,
  \`drop_otp\` varchar(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`drop_note\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`items_count\` int NOT NULL DEFAULT '1',
  \`distance_km\` decimal(5,1) NOT NULL DEFAULT '0.0',
  \`eta_min\` int NOT NULL DEFAULT '0',
  \`payment_type\` enum('COD','PG') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'COD',
  \`cash_to_collect\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`cash_collected\` tinyint(1) NOT NULL DEFAULT '0',
  \`earn_base\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`earn_distance\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`earn_surge\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`earn_tip\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`earn_total\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`proof_photo\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  \`offered_at\` datetime NOT NULL,
  \`accepted_at\` datetime DEFAULT NULL,
  \`picked_up_at\` datetime DEFAULT NULL,
  \`delivered_at\` datetime DEFAULT NULL,
  \`dispatch_at\` datetime DEFAULT NULL,
  \`dispatch_state\` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`search_radius_km\` decimal(5,2) DEFAULT NULL,
  \`offer_round\` smallint DEFAULT '0',
  \`dispatch_note\` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`batch_id\` int DEFAULT NULL,
  PRIMARY KEY (\`do_id\`),
  KEY \`do_partner_idx\` (\`dp_id\`) USING BTREE,
  KEY \`do_status_idx\` (\`status\`) USING BTREE,
  KEY \`do_dispatch_idx\` (\`dispatch_state\`,\`dispatch_at\`),
  CONSTRAINT \`store_delivery_orders_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_sessions",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_sessions\` (
  \`session_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`shift_id\` int DEFAULT NULL,
  \`session_date\` date NOT NULL,
  \`started_at\` datetime NOT NULL,
  \`ended_at\` datetime DEFAULT NULL,
  \`duration_min\` int NOT NULL DEFAULT '0',
  \`start_lat\` decimal(10,7) DEFAULT NULL,
  \`start_lng\` decimal(10,7) DEFAULT NULL,
  \`end_lat\` decimal(10,7) DEFAULT NULL,
  \`end_lng\` decimal(10,7) DEFAULT NULL,
  PRIMARY KEY (\`session_id\`),
  KEY \`dsess_partner_idx\` (\`dp_id\`) USING BTREE,
  KEY \`dsess_date_idx\` (\`session_date\`) USING BTREE,
  CONSTRAINT \`store_delivery_sessions_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  {
    name: "store_delivery_shifts",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_shifts\` (
  \`shift_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`shift_date\` date NOT NULL,
  \`start_time\` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`end_time\` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`label\` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`status\` enum('available','booked','active','completed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'available',
  \`worked_min\` int NOT NULL DEFAULT '0',
  \`break_left_min\` int NOT NULL DEFAULT '0',
  \`login_bonus\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`incentive_bonus\` decimal(10,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (\`shift_id\`),
  KEY \`ds_partner_idx\` (\`dp_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_shifts_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_wallet_txns",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_wallet_txns\` (
  \`txn_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`type\` enum('earning','withdrawal','incentive','adjustment') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`direction\` enum('credit','debit') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`amount\` decimal(10,2) NOT NULL,
  \`title\` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`description\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`ref_order_id\` int DEFAULT NULL,
  \`status\` enum('settled','pending') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'settled',
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`txn_id\`),
  KEY \`dwt_partner_idx\` (\`dp_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_wallet_txns_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_order_events",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_order_events\` (
  \`event_id\` int NOT NULL AUTO_INCREMENT,
  \`do_id\` int NOT NULL,
  \`dp_id\` int DEFAULT NULL,
  \`status\` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`note\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`event_id\`),
  KEY \`doe_order_idx\` (\`do_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_order_events_ibfk_1\` FOREIGN KEY (\`do_id\`) REFERENCES \`store_delivery_orders\` (\`do_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_delivery_session_points",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_session_points\` (
  \`point_id\` int NOT NULL AUTO_INCREMENT,
  \`session_id\` int NOT NULL,
  \`dp_id\` int NOT NULL,
  \`recorded_at\` datetime NOT NULL,
  \`lat\` decimal(10,7) NOT NULL,
  \`lng\` decimal(10,7) NOT NULL,
  PRIMARY KEY (\`point_id\`),
  KEY \`dsp_session_idx\` (\`session_id\`) USING BTREE,
  KEY \`dsp_partner_idx\` (\`dp_id\`) USING BTREE,
  CONSTRAINT \`store_delivery_session_points_ibfk_1\` FOREIGN KEY (\`session_id\`) REFERENCES \`store_delivery_sessions\` (\`session_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  // ── Promotional push notifications (admin-composed, sent to all customers) ──
  // See util/promoNotificationSweeper.js for the sender and util/coupon.js for
  // how promo_code turns into an actual checkout discount.
  {
    name: "store_promo_campaigns",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_promo_campaigns\` (
  \`campaign_id\` int NOT NULL AUTO_INCREMENT,
  \`title\` varchar(160) NOT NULL,
  \`body\` varchar(255) DEFAULT NULL,
  \`image\` varchar(255) DEFAULT NULL,
  \`offer_type\` enum('none','percent_off','flat_off','free_delivery') NOT NULL DEFAULT 'none',
  \`offer_value\` decimal(10,2) DEFAULT NULL,
  \`min_order_amount\` decimal(10,2) DEFAULT NULL,
  \`promo_code\` varchar(24) DEFAULT NULL,
  \`usage_limit_per_user\` smallint NOT NULL DEFAULT 1,
  \`expires_at\` datetime DEFAULT NULL,
  \`scheduled_at\` datetime NOT NULL,
  \`sent_at\` datetime DEFAULT NULL,
  \`status\` enum('draft','scheduled','sending','sent','cancelled','failed') NOT NULL DEFAULT 'draft',
  \`target_count\` int NOT NULL DEFAULT 0,
  \`sent_count\` int NOT NULL DEFAULT 0,
  \`failed_count\` int NOT NULL DEFAULT 0,
  \`created_by\` int DEFAULT NULL,
  \`created_at\` datetime NOT NULL,
  \`updated_at\` datetime NOT NULL,
  PRIMARY KEY (\`campaign_id\`),
  UNIQUE KEY \`promo_code_uniq\` (\`promo_code\`),
  KEY \`promo_due_idx\` (\`status\`,\`scheduled_at\`),
  CONSTRAINT \`store_promo_campaigns_ibfk_1\` FOREIGN KEY (\`created_by\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_promo_targets",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_promo_targets\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`campaign_id\` int NOT NULL,
  \`business_user_id\` int DEFAULT NULL,
  \`product_id\` int DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`promo_target_campaign_idx\` (\`campaign_id\`),
  KEY \`promo_target_vendor_idx\` (\`business_user_id\`),
  KEY \`promo_target_product_idx\` (\`product_id\`),
  CONSTRAINT \`store_promo_targets_ibfk_1\` FOREIGN KEY (\`campaign_id\`) REFERENCES \`store_promo_campaigns\` (\`campaign_id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`store_promo_targets_ibfk_2\` FOREIGN KEY (\`business_user_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`store_promo_targets_ibfk_3\` FOREIGN KEY (\`product_id\`) REFERENCES \`store_products\` (\`product_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  {
    name: "store_promo_redemptions",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_promo_redemptions\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`campaign_id\` int NOT NULL,
  \`user_id\` int NOT NULL,
  \`order_id\` int DEFAULT NULL,
  \`discount_amount\` decimal(10,2) NOT NULL DEFAULT 0.00,
  \`created_at\` datetime NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`promo_redemption_usage_idx\` (\`campaign_id\`,\`user_id\`),
  KEY \`promo_redemption_order_idx\` (\`order_id\`),
  CONSTRAINT \`store_promo_redemptions_ibfk_1\` FOREIGN KEY (\`campaign_id\`) REFERENCES \`store_promo_campaigns\` (\`campaign_id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`store_promo_redemptions_ibfk_2\` FOREIGN KEY (\`user_id\`) REFERENCES \`store_users\` (\`user_id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  // ── Rider online time and online pay ─────────────────────────────────
  // See RIDER_ONLINE_PAY.md and util/presence/. Times are epoch milliseconds
  // (BIGINT) so nothing between the phone, Node and MySQL converts timezones.
  //
  // A span is a run of the rider's 5-second location fixes no more than
  // PRESENCE_GAP_MIN apart. A zero-length span ended "offline" is a go-offline
  // marker (util/presence/spans.js). No foreign key to store_users: the ingest
  // path is the hottest write in the app and the ids come from a verified token.
  {
    name: "store_rider_presence_spans",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_rider_presence_spans\` (
  \`span_id\` bigint NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`start_ms\` bigint NOT NULL,
  \`end_ms\` bigint NOT NULL,
  \`samples\` int NOT NULL DEFAULT '0',
  \`end_reason\` varchar(16) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`start_lat\` decimal(10,7) DEFAULT NULL,
  \`start_lng\` decimal(10,7) DEFAULT NULL,
  \`end_lat\` decimal(10,7) DEFAULT NULL,
  \`end_lng\` decimal(10,7) DEFAULT NULL,
  \`updated_ms\` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (\`span_id\`),
  KEY \`rps_partner_end_idx\` (\`dp_id\`,\`end_ms\`) USING BTREE,
  KEY \`rps_end_idx\` (\`end_ms\`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
  // One row per rider per IST day: what their online time was worth and what
  // has been credited. Unique on (dp_id, pay_date) so a day is never paid twice;
  // a late-synced backlog pays only the difference. txn_ids lists every wallet
  // entry written for the day, for audit.
  {
    name: "store_rider_online_pay",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_rider_online_pay\` (
  \`pay_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_id\` int NOT NULL,
  \`pay_date\` date NOT NULL,
  \`online_min\` int NOT NULL DEFAULT '0',
  \`rate_per_hour\` decimal(10,2) NOT NULL,
  \`paid_paise\` int NOT NULL DEFAULT '0',
  \`txn_ids\` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`updated_ms\` bigint NOT NULL DEFAULT '0',
  PRIMARY KEY (\`pay_id\`),
  UNIQUE KEY \`rop_partner_day_uq\` (\`dp_id\`,\`pay_date\`),
  KEY \`rop_day_idx\` (\`pay_date\`) USING BTREE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  },
];

/**
 * Columns added to tables the legacy schema already has.
 *
 * Each is guarded on its own presence, so a database that has some of them
 * (the usual state of anything that was migrated by hand) gets exactly the
 * ones it is missing.
 */
const COLUMNS = [
  { table: "store_orders", column: "order_accepted_time", sql: "ALTER TABLE `store_orders` ADD COLUMN `order_accepted_time` datetime NULL" },
  { table: "store_orders", column: "order_prep_minutes", sql: "ALTER TABLE `store_orders` ADD COLUMN `order_prep_minutes` smallint NULL" },
  { table: "store_orders", column: "order_cancel_reason", sql: "ALTER TABLE `store_orders` ADD COLUMN `order_cancel_reason` varchar(255) NULL" },
  { table: "store_orders", column: "order_cancelled_by", sql: "ALTER TABLE `store_orders` ADD COLUMN `order_cancelled_by` varchar(16) NULL" },
  { table: "store_users", column: "user_lat", sql: "ALTER TABLE `store_users` ADD COLUMN `user_lat` decimal(10,7) NULL" },
  { table: "store_users", column: "user_lng", sql: "ALTER TABLE `store_users` ADD COLUMN `user_lng` decimal(10,7) NULL" },
  { table: "store_users", column: "user_formatted", sql: "ALTER TABLE `store_users` ADD COLUMN `user_formatted` varchar(255) NULL" },
  { table: "store_users", column: "user_place_id", sql: "ALTER TABLE `store_users` ADD COLUMN `user_place_id` varchar(128) NULL" },

  // Delivery-partner fields. A partner is a store_users row with user_role 3;
  // see migrations/2026-08-21-unify-delivery-partners-into-store-users.sql.
  { table: "store_users", column: "dp_code", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_code` varchar(12) NOT NULL DEFAULT ''" },
  { table: "store_users", column: "dp_request_id", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_request_id` varchar(100) NULL" },
  { table: "store_users", column: "dp_token_version", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_token_version` int(11) NOT NULL DEFAULT 1" },
  { table: "store_users", column: "dp_settings", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_settings` longtext NULL" },
  { table: "store_users", column: "dp_vehicle_type", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_vehicle_type` varchar(30) NOT NULL DEFAULT 'Bike'" },
  { table: "store_users", column: "dp_vehicle_number", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_vehicle_number` varchar(20) NULL" },
  // Its own column rather than store_users.user_image, which is varchar(100)
  // and would truncate a base64 selfie to 100 characters without erroring.
  { table: "store_users", column: "dp_photo", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_photo` longtext NULL" },
  { table: "store_users", column: "dp_verification_status", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_verification_status` enum('pending','under_review','approved','rejected') NOT NULL DEFAULT 'pending'" },
  { table: "store_users", column: "dp_rejection_reason", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_rejection_reason` varchar(255) NULL" },
  { table: "store_users", column: "dp_submitted_at", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_submitted_at` datetime NULL" },
  { table: "store_users", column: "dp_reviewed_at", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_reviewed_at` datetime NULL" },
  { table: "store_users", column: "dp_bank_account", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_bank_account` varchar(30) NULL" },
  { table: "store_users", column: "dp_bank_ifsc", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_bank_ifsc` varchar(15) NULL" },
  { table: "store_users", column: "dp_bank_holder", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_bank_holder` varchar(80) NULL" },
  { table: "store_users", column: "dp_upi_id", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_upi_id` varchar(80) NULL" },
  { table: "store_users", column: "dp_online", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_online` tinyint(1) NOT NULL DEFAULT 0" },
  { table: "store_users", column: "dp_lat", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_lat` decimal(10,7) NULL" },
  { table: "store_users", column: "dp_lng", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_lng` decimal(10,7) NULL" },
  { table: "store_users", column: "dp_wallet_balance", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_wallet_balance` decimal(10,2) NOT NULL DEFAULT 0.00" },
  { table: "store_users", column: "dp_cash_in_hand", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_cash_in_hand` decimal(10,2) NOT NULL DEFAULT 0.00" },
  { table: "store_users", column: "dp_rating", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_rating` decimal(3,2) NOT NULL DEFAULT 5.00" },
  { table: "store_users", column: "dp_total_deliveries", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_total_deliveries` int(11) NOT NULL DEFAULT 0" },
  { table: "store_users", column: "dp_on_time_pct", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_on_time_pct` int(11) NOT NULL DEFAULT 100" },
  { table: "store_users", column: "dp_acceptance_pct", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_acceptance_pct` int(11) NOT NULL DEFAULT 100" },
  { table: "store_users", column: "dp_completion_pct", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_completion_pct` int(11) NOT NULL DEFAULT 100" },
  { table: "store_users", column: "dp_cancellation_pct", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_cancellation_pct` decimal(4,1) NOT NULL DEFAULT 0.0" },
  { table: "store_users", column: "dp_avg_delivery_min", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_avg_delivery_min` int(11) NOT NULL DEFAULT 0" },
  { table: "store_users", column: "dp_active", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_active` tinyint(1) NOT NULL DEFAULT 1" },
  { table: "store_users_shipping_address", column: "delivery_lat", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_lat` decimal(10,7) NULL" },
  { table: "store_users_shipping_address", column: "delivery_lng", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_lng` decimal(10,7) NULL" },
  { table: "store_users_shipping_address", column: "delivery_house", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_house` varchar(255) NULL" },
  { table: "store_users_shipping_address", column: "delivery_label", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_label` varchar(20) NULL" },
  { table: "store_users_shipping_address", column: "delivery_formatted", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_formatted` varchar(500) NULL" },
  { table: "store_users_shipping_address", column: "delivery_place_id", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_place_id` varchar(255) NULL" },
  // Columns that previously existed only in the hand-run .sql migrations.
  // Listed here so a database provisioned by boot alone is complete — the
  // dispatch engine and doorstep collection both probe for their columns and
  // stay dormant when absent, so a gap here is a feature that silently never
  // starts rather than an error anyone would notice.
  // AFTER clauses are dropped deliberately: column order is irrelevant and an
  // AFTER referencing a column that does not exist yet fails the ALTER.
  { table: "store_delivery_sessions", column: "start_lat", sql: "ALTER TABLE `store_delivery_sessions` ADD COLUMN `start_lat` DECIMAL(10,7) NULL" },
  { table: "store_delivery_sessions", column: "start_lng", sql: "ALTER TABLE `store_delivery_sessions` ADD COLUMN `start_lng` DECIMAL(10,7) NULL" },
  { table: "store_delivery_sessions", column: "end_lat", sql: "ALTER TABLE `store_delivery_sessions` ADD COLUMN `end_lat` DECIMAL(10,7) NULL" },
  { table: "store_delivery_sessions", column: "end_lng", sql: "ALTER TABLE `store_delivery_sessions` ADD COLUMN `end_lng` DECIMAL(10,7) NULL" },
  { table: "store_delivery_orders", column: "dispatch_at", sql: "ALTER TABLE `store_delivery_orders` ADD COLUMN `dispatch_at` DATETIME NULL" },
  { table: "store_delivery_orders", column: "dispatch_state", sql: "ALTER TABLE `store_delivery_orders` ADD COLUMN `dispatch_state` VARCHAR(16) NULL" },
  { table: "store_delivery_orders", column: "search_radius_km", sql: "ALTER TABLE `store_delivery_orders` ADD COLUMN `search_radius_km` DECIMAL(5,2) NULL" },
  { table: "store_delivery_orders", column: "offer_round", sql: "ALTER TABLE `store_delivery_orders` ADD COLUMN `offer_round` SMALLINT NULL DEFAULT 0" },
  { table: "store_delivery_orders", column: "dispatch_note", sql: "ALTER TABLE `store_delivery_orders` ADD COLUMN `dispatch_note` VARCHAR(255) NULL" },
  { table: "store_delivery_orders", column: "batch_id", sql: "ALTER TABLE `store_delivery_orders` ADD COLUMN `batch_id` INT NULL" },
  { table: "store_users", column: "dp_max_concurrent", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_max_concurrent` TINYINT NULL DEFAULT 1" },
  { table: "store_users", column: "dp_last_offer_at", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_last_offer_at` DATETIME NULL" },
  { table: "store_users", column: "dp_location_at", sql: "ALTER TABLE `store_users` ADD COLUMN `dp_location_at` DATETIME NULL" },
  { table: "store_payment_intents", column: "merchant_refund_id", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `merchant_refund_id` VARCHAR(64) NULL" },
  { table: "store_payment_intents", column: "provider_refund_id", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `provider_refund_id` VARCHAR(64) NULL" },
  { table: "store_payment_intents", column: "refund_status", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `refund_status` VARCHAR(16) NULL" },
  { table: "store_payment_intents", column: "refund_amount", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `refund_amount` DECIMAL(10,2) NULL" },
  { table: "store_payment_intents", column: "refunded_at", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `refunded_at` DATETIME NULL" },
  { table: "store_payment_intents", column: "refund_failure", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `refund_failure` VARCHAR(255) NULL" },
  { table: "store_payment_intents", column: "purpose", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `purpose` VARCHAR(16) NULL" },
  { table: "store_payment_intents", column: "do_id", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `do_id` INT NULL" },
  { table: "store_payment_intents", column: "collected_by_dp_id", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `collected_by_dp_id` INT NULL" },
  { table: "store_payment_intents", column: "collect_url", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `collect_url` VARCHAR(1000) NULL" },
  { table: "store_payment_intents", column: "expires_at", sql: "ALTER TABLE `store_payment_intents` ADD COLUMN `expires_at` DATETIME NULL" },

  // Which delivery partner an admin alert refers to, so the panel notification
  // can deep-link to the application. Nullable and ignored by every existing
  // reader — the customer feed selects named columns, not *.
  { table: "store_user_notifications", column: "ref_partner_id", sql: "ALTER TABLE `store_user_notifications` ADD COLUMN `ref_partner_id` INT NULL" },

  // A promo campaign's deep-link target, carried on each customer's own
  // notification row so tapping it from the in-app list (not just a live push)
  // still knows where to go. See util/promoNotificationSweeper.js.
  { table: "store_user_notifications", column: "image", sql: "ALTER TABLE `store_user_notifications` ADD COLUMN `image` VARCHAR(255) NULL" },
  { table: "store_user_notifications", column: "ref_business_user_id", sql: "ALTER TABLE `store_user_notifications` ADD COLUMN `ref_business_user_id` INT NULL" },
  { table: "store_user_notifications", column: "ref_promo_code", sql: "ALTER TABLE `store_user_notifications` ADD COLUMN `ref_promo_code` VARCHAR(24) NULL" },

  // Shift completion, measured from presence spans (util/presence/shifts.js).
  // Deliberately NOT named on the DeliveryShift model: a model column is in
  // every SELECT, and would break the shift screens on a database that has not
  // migrated yet. Read and written with raw SQL instead.
  { table: "store_delivery_shifts", column: "offline_min", sql: "ALTER TABLE `store_delivery_shifts` ADD COLUMN `offline_min` INT NULL" },
  { table: "store_delivery_shifts", column: "completion", sql: "ALTER TABLE `store_delivery_shifts` ADD COLUMN `completion` VARCHAR(16) NULL" },
  { table: "store_delivery_shifts", column: "evaluated_ms", sql: "ALTER TABLE `store_delivery_shifts` ADD COLUMN `evaluated_ms` BIGINT NULL" },

];

module.exports = { TABLES, COLUMNS };
