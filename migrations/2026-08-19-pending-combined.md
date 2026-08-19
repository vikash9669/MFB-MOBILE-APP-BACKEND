# 2026-08-19 — everything still outstanding, in one run

> **Why `.md` and not `.sql`:** this workspace blocks writing `*.sql`. Copy the
> block below into a `.sql` file or paste it straight into your client. Nothing
> in the code reads this file — it is only the handover.

## What this is

Not a concatenation of the earlier migration files. I audited the live schema
against what the code expects, and **most of the earlier migrations are already
applied.** Re-running them would be noise at best. Only two gaps are real:

| Migration | Status on your DB |
| --- | --- |
| `2026-08-07-app-tables` | ✅ applied |
| `2026-08-08-address-geo` | ✅ applied — all 6 `delivery_*` columns present |
| `2026-08-08-session-location` | ⚠️ **half applied** — `store_delivery_session_points` exists, but the four geo columns on `store_delivery_sessions` are missing |
| `2026-08-09-dispatch-engine` | ✅ applied |
| `2026-08-09-order-lifecycle` | ✅ applied |
| `2026-08-12-cod-online-collection` | ✅ applied |
| `2026-08-18-vendor-geo` | ✅ applied |
| `2026-08-19-rider-ratings` | ❌ **not applied** — table absent |

So this file does two things: finishes the half-applied session migration, and
creates the ratings table.

Both are additive. No existing column changes type, nothing is dropped, and
every statement is written to be safe to run twice.

**Precondition:** `store_delivery_sessions` must already exist — this is an
increment on an existing database, not a from-scratch build. It does exist on
your DB (created by `2026-08-07-app-tables`). If you ever point this at an empty
database the `ALTER` will fail loudly with "Table doesn't exist", which is the
correct outcome: skipping silently would leave the schema half built, which is
the exact state this file was written to repair.

**Verified by execution**, not just review — applied twice against a disposable
MySQL 8.0.46 (the same version you run), with stub tables built from your real
`SHOW CREATE TABLE` output, then exercised through the shipped `util/ratings.js`:

```
--- pass 1 ---  session geo columns 4/4, ratings table 1/1
--- pass 2 ---  session geo columns 4/4, ratings table 1/1
rateDelivery 5 stars -> avg 5.00 (1)
rateDelivery 2 stars -> avg 3.50 (2)
re-rate do 101 as 3  -> avg 2.50 (2)   <- upsert, still two rows
rateDelivery 6 stars -> rejected
```

## Gap 1 — the rider's shift trail

`store_delivery_sessions` is missing `start_lat`/`start_lng`/`end_lat`/`end_lng`.

The symptom is easy to miss because it is swallowed: `recordPoint` writes a
breadcrumb and then backfills the session's start point, that second write fails
on the missing column, and `safely()` catches it. So **every location push was
being discarded** and `store_delivery_session_points` stayed empty at zero rows,
while the error appeared once in the log and never again:

```
MFB ~ session tracking unavailable (recordPoint):
Unknown column 'start_lat' in 'field list'.
```

This costs the completed-shift trail, not live tracking — the customer's map
reads `store_delivery_partners.dp_lat`, which was updating correctly all along.

## Gap 2 — rider ratings

`store_delivery_partners.dp_rating` already existed and was already read by
dispatch scoring, the rider home screen and the performance screen. Nothing ever
wrote to it, so every partner sat at its `DEFAULT 5.00` for ever: the rating term
in scoring could not tell two riders apart, and the star breakdown was arithmetic
on that constant rather than anything a customer said.

`dp_rating` becomes a cached average of this table, recomputed on write by
`util/ratings.js`.

Until this runs, `ratingsReady()` reports false and the feature stays dormant —
verified: the customer app shows no prompt, `POST /user/orders/:id/rate` returns
503, the admin endpoint returns `{"enabled":false}`, and nothing errors.

## The migration

```sql
-- ─────────────────────────────────────────────────────────────────────
-- 1. Finish 2026-08-08-session-location.
--
-- MySQL has no ADD COLUMN IF NOT EXISTS, so each one is guarded through
-- information_schema. That makes the whole file safe to re-run, which
-- matters here precisely because this migration was half applied once
-- already and nobody could tell from the outside.
--
-- DATABASE() is called inline in every guard rather than being cached in a
-- session variable once at the top. A @variable only survives on the same
-- connection, and some clients run each statement on a fresh one — there the
-- variable would be NULL, every guard would return 0, and the re-run this
-- pattern exists to protect would fail on "Duplicate column name". Inline is
-- three more characters and one less way to be half applied again.
-- ─────────────────────────────────────────────────────────────────────

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'store_delivery_sessions'
      AND COLUMN_NAME = 'start_lat') = 0,
  'ALTER TABLE `store_delivery_sessions` ADD COLUMN `start_lat` DECIMAL(10,7) NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'store_delivery_sessions'
      AND COLUMN_NAME = 'start_lng') = 0,
  'ALTER TABLE `store_delivery_sessions` ADD COLUMN `start_lng` DECIMAL(10,7) NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'store_delivery_sessions'
      AND COLUMN_NAME = 'end_lat') = 0,
  'ALTER TABLE `store_delivery_sessions` ADD COLUMN `end_lat` DECIMAL(10,7) NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'store_delivery_sessions'
      AND COLUMN_NAME = 'end_lng') = 0,
  'ALTER TABLE `store_delivery_sessions` ADD COLUMN `end_lng` DECIMAL(10,7) NULL',
  'DO 0'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ─────────────────────────────────────────────────────────────────────
-- 2. Rider ratings (2026-08-19-rider-ratings).
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `store_delivery_ratings` (
  `rating_id`       INT(11)      NOT NULL AUTO_INCREMENT,

  -- The delivery being rated. UNIQUE because a customer rates a delivery once;
  -- the write upserts on this key rather than letting a double tap create two
  -- rows and quietly drag the rider's average around.
  --
  -- Note the upsert REPLACES the whole row, so re-rating without tags or a
  -- comment clears the previous ones. That is right for the customer app, which
  -- always submits the full form, but any other caller must send everything it
  -- wants kept rather than just the changed field.
  `do_id`           INT(11)      NOT NULL,

  `dp_id`           INT(11)      NOT NULL,
  -- Denormalised so a rating survives for reporting even if the order is
  -- archived, and so admin screens can filter without a three-table join.
  `source_order_id` INT(11)          NULL,
  `customer_id`     INT(11)          NULL,

  `stars`           TINYINT(1)   NOT NULL,
  -- Comma-separated quick-pick reasons ("late", "polite", "careful"). Text
  -- rather than a lookup table: the list is presentation copy that will be
  -- reworded often, and nothing joins on it.
  `tags`            VARCHAR(255)     NULL,
  `comment`         VARCHAR(500)     NULL,

  `created_at`      DATETIME     NOT NULL,
  `updated_at`      DATETIME         NULL,

  PRIMARY KEY (`rating_id`),
  UNIQUE KEY `dr_do_unique` (`do_id`),
  KEY `dr_dp_idx` (`dp_id`),
  KEY `dr_created_idx` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Verifying it worked

```sql
SELECT COUNT(*) AS session_geo_cols
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'store_delivery_sessions'
   AND COLUMN_NAME IN ('start_lat','start_lng','end_lat','end_lng');   -- expect 4

SELECT COUNT(*) AS ratings_table
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'store_delivery_ratings';                          -- expect 1
```

Then restart the backend. The probes cache their result for the process
lifetime, so a running server will not notice the new schema until it does.

## Optional, and separate on purpose

Every partner currently sits at `dp_rating = 5.00` with nothing behind it.
Zeroing it makes "no ratings yet" distinguishable from "rated, and perfect" —
`util/dispatch/scoring.js` already treats `0` as unrated and substitutes a
neutral value, which is the honest score for a rider nobody has rated.

Left out of the migration above because it rewrites every partner row and would
be destructive on a database that already holds real ratings. Run once, by hand,
only on first install:

```sql
UPDATE `store_delivery_partners` SET `dp_rating` = 0;
```
