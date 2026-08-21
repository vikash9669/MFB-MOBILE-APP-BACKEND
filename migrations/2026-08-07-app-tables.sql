-- Tables the mobile apps need that are ABSENT from the production snapshot.
-- Generated from the verified mfb_app_dev replica on 2026-08-07.
--
-- Review before running. CREATE TABLE IF NOT EXISTS: safe to re-run, and it
-- will not modify any table that already exists.
--
-- Apply:  mysql -h HOST -u USER -p DATABASE < 2026-08-07-app-tables.sql

SET FOREIGN_KEY_CHECKS=0;
-- store_delivery_partners is deliberately NOT created here.
--
-- A delivery partner is a store_users row with user_role = 3; the partner
-- fields live on store_users. This file used to create a separate table, which
-- meant a fresh install built it only for
-- 2026-08-21-unify-delivery-partners-into-store-users.sql to rename it away
-- moments later — and, worse, gave the phone-number join between the two
-- tables a chance to mis-link a customer to an application.
--
-- The child tables below reference store_users(user_id) directly.

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_documents` (
  `doc_id` int NOT NULL AUTO_INCREMENT,
  `dp_id` int NOT NULL,
  `doc_type` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `title` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('active','expiring','pending','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'active',
  `expires_on` date DEFAULT NULL,
  `file_url` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`doc_id`),
  KEY `dd_partner_idx` (`dp_id`) USING BTREE,
  CONSTRAINT `store_delivery_documents_ibfk_1` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_orders` (
  `do_id` int NOT NULL AUTO_INCREMENT,
  `dp_id` int DEFAULT NULL,
  `source_order_id` int DEFAULT NULL,
  `order_ref` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('offered','accepted','picked_up','delivered','cancelled','rejected') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'offered',
  `pickup_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `pickup_address` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `pickup_area` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `pickup_phone` varchar(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `pickup_lat` decimal(10,7) DEFAULT NULL,
  `pickup_lng` decimal(10,7) DEFAULT NULL,
  `pickup_otp` varchar(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `pickup_distance_km` decimal(5,1) DEFAULT NULL,
  `ready_in_min` int DEFAULT '4',
  `drop_name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `drop_address` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `drop_area` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `drop_phone` varchar(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `drop_lat` decimal(10,7) DEFAULT NULL,
  `drop_lng` decimal(10,7) DEFAULT NULL,
  `drop_otp` varchar(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `drop_note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `items_count` int NOT NULL DEFAULT '1',
  `distance_km` decimal(5,1) NOT NULL DEFAULT '0.0',
  `eta_min` int NOT NULL DEFAULT '0',
  `payment_type` enum('COD','PG') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'COD',
  `cash_to_collect` decimal(10,2) NOT NULL DEFAULT '0.00',
  `cash_collected` tinyint(1) NOT NULL DEFAULT '0',
  `earn_base` decimal(10,2) NOT NULL DEFAULT '0.00',
  `earn_distance` decimal(10,2) NOT NULL DEFAULT '0.00',
  `earn_surge` decimal(10,2) NOT NULL DEFAULT '0.00',
  `earn_tip` decimal(10,2) NOT NULL DEFAULT '0.00',
  `earn_total` decimal(10,2) NOT NULL DEFAULT '0.00',
  `proof_photo` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `offered_at` datetime NOT NULL,
  `accepted_at` datetime DEFAULT NULL,
  `picked_up_at` datetime DEFAULT NULL,
  `delivered_at` datetime DEFAULT NULL,
  PRIMARY KEY (`do_id`),
  KEY `do_partner_idx` (`dp_id`) USING BTREE,
  KEY `do_status_idx` (`status`) USING BTREE,
  CONSTRAINT `store_delivery_orders_ibfk_1` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_order_events` (
  `event_id` int NOT NULL AUTO_INCREMENT,
  `do_id` int NOT NULL,
  `dp_id` int DEFAULT NULL,
  `status` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`event_id`),
  KEY `doe_order_idx` (`do_id`) USING BTREE,
  CONSTRAINT `store_delivery_order_events_ibfk_1` FOREIGN KEY (`do_id`) REFERENCES `store_delivery_orders` (`do_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_shifts` (
  `shift_id` int NOT NULL AUTO_INCREMENT,
  `dp_id` int NOT NULL,
  `shift_date` date NOT NULL,
  `start_time` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `end_time` varchar(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `label` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('available','booked','active','completed') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'available',
  `worked_min` int NOT NULL DEFAULT '0',
  `break_left_min` int NOT NULL DEFAULT '0',
  `login_bonus` decimal(10,2) NOT NULL DEFAULT '0.00',
  `incentive_bonus` decimal(10,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`shift_id`),
  KEY `ds_partner_idx` (`dp_id`) USING BTREE,
  CONSTRAINT `store_delivery_shifts_ibfk_1` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_wallet_txns` (
  `txn_id` int NOT NULL AUTO_INCREMENT,
  `dp_id` int NOT NULL,
  `type` enum('earning','withdrawal','incentive','adjustment') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `direction` enum('credit','debit') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `title` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `description` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ref_order_id` int DEFAULT NULL,
  `status` enum('settled','pending') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'settled',
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`txn_id`),
  KEY `dwt_partner_idx` (`dp_id`) USING BTREE,
  CONSTRAINT `store_delivery_wallet_txns_ibfk_1` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_devices` (
  `device_id` int NOT NULL AUTO_INCREMENT,
  `dp_id` int NOT NULL,
  `token` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `platform` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'android',
  `created_at` datetime NOT NULL,
  `last_seen` datetime NOT NULL,
  PRIMARY KEY (`device_id`),
  UNIQUE KEY `dd_token_uniq` (`token`) USING BTREE,
  KEY `dd_partner_idx` (`dp_id`) USING BTREE,
  CONSTRAINT `store_delivery_devices_ibfk_1` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_delivery_notifications` (
  `notif_id` int NOT NULL AUTO_INCREMENT,
  `dp_id` int NOT NULL,
  `category` enum('orders','payments','bonuses','system') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'system',
  `icon` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `title` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `body` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`notif_id`),
  KEY `dn_partner_idx` (`dp_id`) USING BTREE,
  CONSTRAINT `store_delivery_notifications_ibfk_1` FOREIGN KEY (`dp_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_user_devices` (
  `device_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `token` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `platform` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'android',
  `created_at` datetime NOT NULL,
  `last_seen` datetime NOT NULL,
  PRIMARY KEY (`device_id`),
  UNIQUE KEY `ud_token_uniq` (`token`) USING BTREE,
  KEY `ud_user_idx` (`user_id`) USING BTREE,
  CONSTRAINT `store_user_devices_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_user_notifications` (
  `notif_id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `category` enum('orders','offers','wallet','system') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'system',
  `icon` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `title` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `body` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `ref_order_id` int DEFAULT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`notif_id`),
  KEY `un_user_idx` (`user_id`) USING BTREE,
  CONSTRAINT `store_user_notifications_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_payment_intents` (
  `pi_id` int NOT NULL AUTO_INCREMENT,
  `merchant_txn_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `customer_id` int NOT NULL,
  `vendor_id` int NOT NULL,
  `address_id` int NOT NULL,
  `amount` int NOT NULL,
  `cart_snapshot` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `method` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'UPI',
  `status` enum('PENDING','PAID','FAILED') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'PENDING',
  `provider_txn_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `order_id` int DEFAULT NULL,
  `failure_reason` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `createdAt` datetime NOT NULL,
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`pi_id`),
  UNIQUE KEY `merchant_txn_id` (`merchant_txn_id`),
  KEY `pi_customer_id` (`customer_id`) USING BTREE,
  CONSTRAINT `store_payment_intents_ibfk_1` FOREIGN KEY (`customer_id`) REFERENCES `store_users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `store_orders_log` (
  `log_id` int NOT NULL AUTO_INCREMENT,
  `order_id` int NOT NULL,
  `user_id` int NOT NULL,
  `order_status` int NOT NULL,
  `createdAt` datetime NOT NULL,
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`log_id`),
  KEY `fk_log_order_id` (`order_id`) USING BTREE,
  KEY `fk_log_user_id` (`user_id`) USING BTREE,
  CONSTRAINT `store_orders_log_ibfk_1` FOREIGN KEY (`order_id`) REFERENCES `store_orders` (`order_id`) ON UPDATE CASCADE,
  CONSTRAINT `store_orders_log_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `store_users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET FOREIGN_KEY_CHECKS=1;
