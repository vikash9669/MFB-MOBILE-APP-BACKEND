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
    name: "store_delivery_partners",
    ddl: `CREATE TABLE IF NOT EXISTS \`store_delivery_partners\` (
  \`dp_id\` int NOT NULL AUTO_INCREMENT,
  \`dp_name\` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  \`dp_email\` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT '',
  \`dp_phone\` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`dp_code\` varchar(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  \`dp_request_id\` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_token_version\` int NOT NULL DEFAULT '1',
  \`dp_settings\` json DEFAULT NULL,
  \`dp_vehicle_type\` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Bike',
  \`dp_vehicle_number\` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_photo\` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  \`dp_verification_status\` enum('pending','under_review','approved','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'pending',
  \`dp_rejection_reason\` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_submitted_at\` datetime DEFAULT NULL,
  \`dp_reviewed_at\` datetime DEFAULT NULL,
  \`dp_bank_account\` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_bank_ifsc\` varchar(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_bank_holder\` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_upi_id\` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  \`dp_online\` tinyint(1) NOT NULL DEFAULT '0',
  \`dp_lat\` decimal(10,7) DEFAULT NULL,
  \`dp_lng\` decimal(10,7) DEFAULT NULL,
  \`dp_wallet_balance\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`dp_cash_in_hand\` decimal(10,2) NOT NULL DEFAULT '0.00',
  \`dp_rating\` decimal(3,2) NOT NULL DEFAULT '5.00',
  \`dp_total_deliveries\` int NOT NULL DEFAULT '0',
  \`dp_on_time_pct\` int NOT NULL DEFAULT '100',
  \`dp_acceptance_pct\` int NOT NULL DEFAULT '100',
  \`dp_completion_pct\` int NOT NULL DEFAULT '100',
  \`dp_cancellation_pct\` decimal(4,1) NOT NULL DEFAULT '0.0',
  \`dp_avg_delivery_min\` int NOT NULL DEFAULT '0',
  \`dp_active\` tinyint(1) NOT NULL DEFAULT '1',
  \`dp_registered\` datetime NOT NULL,
  \`dp_last_login\` datetime DEFAULT NULL,
  \`dp_max_concurrent\` tinyint DEFAULT '1',
  \`dp_last_offer_at\` datetime DEFAULT NULL,
  \`dp_location_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`dp_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
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
  CONSTRAINT \`store_delivery_devices_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE CASCADE ON UPDATE CASCADE
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
  CONSTRAINT \`store_delivery_documents_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE CASCADE ON UPDATE CASCADE
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
  CONSTRAINT \`store_delivery_notifications_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE CASCADE ON UPDATE CASCADE
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
  CONSTRAINT \`store_delivery_orders_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE SET NULL ON UPDATE CASCADE
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
  CONSTRAINT \`store_delivery_sessions_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE CASCADE ON UPDATE CASCADE
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
  CONSTRAINT \`store_delivery_shifts_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE CASCADE ON UPDATE CASCADE
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
  CONSTRAINT \`store_delivery_wallet_txns_ibfk_1\` FOREIGN KEY (\`dp_id\`) REFERENCES \`store_delivery_partners\` (\`dp_id\`) ON DELETE CASCADE ON UPDATE CASCADE
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
  { table: "store_users_shipping_address", column: "delivery_lat", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_lat` decimal(10,7) NULL" },
  { table: "store_users_shipping_address", column: "delivery_lng", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_lng` decimal(10,7) NULL" },
  { table: "store_users_shipping_address", column: "delivery_house", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_house` varchar(255) NULL" },
  { table: "store_users_shipping_address", column: "delivery_label", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_label` varchar(20) NULL" },
  { table: "store_users_shipping_address", column: "delivery_formatted", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_formatted` varchar(500) NULL" },
  { table: "store_users_shipping_address", column: "delivery_place_id", sql: "ALTER TABLE `store_users_shipping_address` ADD COLUMN `delivery_place_id` varchar(255) NULL" },
];

module.exports = { TABLES, COLUMNS };
