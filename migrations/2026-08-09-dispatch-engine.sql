-- Delivery assignment engine.
--
-- Moves dispatch from an open marketplace (every online rider sees every job,
-- first POST wins) to targeted sequential offers (the engine scores riders and
-- offers to one at a time, with a deadline). The partner app needs no change:
-- GET /delivery/orders/incoming keeps its contract and simply starts returning
-- the offer aimed at that rider instead of the whole pool.
--
-- Additive and nullable throughout; existing rows read as "legacy job, never
-- went through the engine". util/dispatch/columns.js probes for these and the
-- engine stays dormant until they exist, so this can ship before it is run.
--
-- Run with:
--   mysql -h 127.0.0.1 -P 33061 -u <user> -p <db> < migrations/2026-08-09-dispatch-engine.sql

-- ────────────────────────────────────────────── delivery orders
ALTER TABLE `store_delivery_orders`
  -- When the engine should START looking for a rider. Not the order time:
  -- dispatching the instant a restaurant accepts parks a rider at the counter
  -- for fifteen minutes. Computed from prep time minus travel time.
  ADD COLUMN `dispatch_at`      DATETIME     NULL,
  -- waiting | searching | assigned | failed | cancelled
  ADD COLUMN `dispatch_state`   VARCHAR(16)  NULL,
  -- How wide the current search has grown, in km. Drives the expanding radius.
  ADD COLUMN `search_radius_km` DECIMAL(5,2) NULL,
  -- How many riders have been offered this job so far, across all rounds.
  ADD COLUMN `offer_round`      SMALLINT     NULL DEFAULT 0,
  -- Why dispatch gave up, when it did.
  ADD COLUMN `dispatch_note`    VARCHAR(255) NULL,
  -- Set when several jobs are carried together. Null for a solo delivery.
  ADD COLUMN `batch_id`         INT          NULL;

-- The engine's hot query is "jobs due for dispatch now".
CREATE INDEX `do_dispatch_idx`
  ON `store_delivery_orders` (`dispatch_state`, `dispatch_at`);

-- ────────────────────────────────────────────── offer ledger
--
-- One row per (job, rider) offer. This is the record that makes an offer
-- exclusive and time-boxed, and it doubles as the acceptance-rate source:
-- dp_acceptance_pct was previously guesswork with nothing behind it.
CREATE TABLE IF NOT EXISTS `store_delivery_offers` (
  `offer_id`    INT           NOT NULL AUTO_INCREMENT,
  `do_id`       INT           NOT NULL,
  `dp_id`       INT           NOT NULL,
  -- pending | accepted | rejected | expired | withdrawn
  `state`       VARCHAR(12)   NOT NULL DEFAULT 'pending',
  `round`       SMALLINT      NOT NULL DEFAULT 1,
  -- The score that won this rider the offer, kept so a bad assignment can be
  -- explained after the fact rather than guessed at.
  `score`       DECIMAL(6,3)  NULL,
  `score_parts` VARCHAR(500)  NULL,
  `distance_km` DECIMAL(6,2)  NULL,
  `eta_min`     SMALLINT      NULL,
  `offered_at`  DATETIME      NOT NULL,
  `expires_at`  DATETIME      NOT NULL,
  `responded_at` DATETIME     NULL,
  PRIMARY KEY (`offer_id`),
  -- A rider is offered a given job at most once. Also the guard that stops two
  -- engine ticks racing to offer the same job to the same rider.
  UNIQUE KEY `offer_job_rider_idx` (`do_id`, `dp_id`),
  KEY `offer_live_idx` (`state`, `expires_at`),
  KEY `offer_rider_idx` (`dp_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────────────── dispatch log
--
-- Why a job went where it went. Without this, "why did the far rider get it?"
-- is unanswerable, and dispatch complaints are the ones you cannot reconstruct
-- from the order row alone.
CREATE TABLE IF NOT EXISTS `store_dispatch_logs` (
  `log_id`     INT          NOT NULL AUTO_INCREMENT,
  `do_id`      INT          NOT NULL,
  `dp_id`      INT          NULL,
  -- scheduled | search | offer | accept | reject | expire | reassign |
  -- exhausted | failed
  `event`      VARCHAR(20)  NOT NULL,
  `radius_km`  DECIMAL(5,2) NULL,
  `candidates` SMALLINT     NULL,
  `detail`     VARCHAR(500) NULL,
  `created_at` DATETIME     NOT NULL,
  PRIMARY KEY (`log_id`),
  KEY `dispatch_log_job_idx` (`do_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────────────── batches
CREATE TABLE IF NOT EXISTS `store_delivery_batches` (
  `batch_id`    INT          NOT NULL AUTO_INCREMENT,
  `dp_id`       INT          NULL,
  -- open | assigned | completed | cancelled
  `state`       VARCHAR(12)  NOT NULL DEFAULT 'open',
  `orders_count` SMALLINT    NOT NULL DEFAULT 0,
  `total_km`    DECIMAL(6,2) NULL,
  `created_at`  DATETIME     NOT NULL,
  `assigned_at` DATETIME     NULL,
  PRIMARY KEY (`batch_id`),
  KEY `batch_rider_idx` (`dp_id`, `state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────────────── rider capacity
ALTER TABLE `store_delivery_partners`
  -- How many concurrent jobs this rider may carry. 1 keeps today's behaviour
  -- exactly; raising it is what enables batching for that rider.
  ADD COLUMN `dp_max_concurrent` TINYINT NULL DEFAULT 1,
  -- Last time the engine offered this rider anything, so the scorer can favour
  -- riders who have been waiting — otherwise the same few near the market get
  -- every job and everyone else earns nothing.
  ADD COLUMN `dp_last_offer_at`  DATETIME NULL,
  -- Freshness of dp_lat/dp_lng. A rider whose GPS died an hour ago must not be
  -- scored as if they are still parked outside the restaurant.
  ADD COLUMN `dp_location_at`    DATETIME NULL;
