# 2026-08-20 — timezone data fix + vendor data cleanup

Two unrelated jobs that both need writes against the real database, so both are
here for you to run rather than something I applied.

> As with the last one: this workspace blocks writing `*.sql`, so copy the
> blocks into a file or paste them into your client. Nothing reads this file.

**Take a backup first.** Section 1 rewrites timestamps in place and is not
idempotent — running it twice shifts everything by 11 hours.

---

## Section 1 — realign the delivery-era timestamps  (REQUIRED)

### Why

Every DATETIME in this database holds **IST wall-clock** time, because the PHP
panel runs under `date_default_timezone_set('Asia/Kolkata')`. Sequelize was
connecting with the default `+00:00`, so it read those 156k legacy rows as if
they were UTC — 5h30m wrong in every report.

`util/database.js` now declares `timezone: "+05:30"`, which fixes reads and
writes against the legacy convention, and the manual `+ 5.5h` in
`util/orders.js` was removed because it would now double-shift.

Verified after the change: the newest order reads as `2026-08-18T19:43:47Z`,
and the notification mail for that same order was written at
`2026-08-18T19:43:48Z`. One second apart. Before the fix it read `01:13Z`.

### What still needs fixing

The `store_delivery_*` tables were written by this backend under the old
`+00:00` setting, so they hold **UTC wall-clock** — the opposite convention to
everything else. With the driver now on `+05:30` they will read 5h30m early
until they are shifted forward to match.

141 rows across 11 tables. The legacy tables are **not** touched.

```sql
UPDATE `store_delivery_devices` SET
      `created_at` = DATE_ADD(`created_at`, INTERVAL 330 MINUTE),
      `last_seen` = DATE_ADD(`last_seen`, INTERVAL 330 MINUTE);   -- 2 rows
UPDATE `store_delivery_documents` SET
      `updated_at` = DATE_ADD(`updated_at`, INTERVAL 330 MINUTE);   -- 10 rows
UPDATE `store_delivery_notifications` SET
      `created_at` = DATE_ADD(`created_at`, INTERVAL 330 MINUTE);   -- 45 rows
UPDATE `store_delivery_offers` SET
      `offered_at` = DATE_ADD(`offered_at`, INTERVAL 330 MINUTE),
      `expires_at` = DATE_ADD(`expires_at`, INTERVAL 330 MINUTE),
      `responded_at` = DATE_ADD(`responded_at`, INTERVAL 330 MINUTE);   -- 10 rows
UPDATE `store_delivery_order_events` SET
      `created_at` = DATE_ADD(`created_at`, INTERVAL 330 MINUTE);   -- 20 rows
UPDATE `store_delivery_orders` SET
      `offered_at` = DATE_ADD(`offered_at`, INTERVAL 330 MINUTE),
      `accepted_at` = DATE_ADD(`accepted_at`, INTERVAL 330 MINUTE),
      `picked_up_at` = DATE_ADD(`picked_up_at`, INTERVAL 330 MINUTE),
      `delivered_at` = DATE_ADD(`delivered_at`, INTERVAL 330 MINUTE),
      `dispatch_at` = DATE_ADD(`dispatch_at`, INTERVAL 330 MINUTE);   -- 37 rows
UPDATE `store_delivery_partners` SET
      `dp_submitted_at` = DATE_ADD(`dp_submitted_at`, INTERVAL 330 MINUTE),
      `dp_reviewed_at` = DATE_ADD(`dp_reviewed_at`, INTERVAL 330 MINUTE),
      `dp_registered` = DATE_ADD(`dp_registered`, INTERVAL 330 MINUTE),
      `dp_last_login` = DATE_ADD(`dp_last_login`, INTERVAL 330 MINUTE),
      `dp_last_offer_at` = DATE_ADD(`dp_last_offer_at`, INTERVAL 330 MINUTE),
      `dp_location_at` = DATE_ADD(`dp_location_at`, INTERVAL 330 MINUTE);   -- 4 rows
UPDATE `store_delivery_ratings` SET
      `created_at` = DATE_ADD(`created_at`, INTERVAL 330 MINUTE),
      `updated_at` = DATE_ADD(`updated_at`, INTERVAL 330 MINUTE);   -- 2 rows
UPDATE `store_delivery_session_points` SET
      `recorded_at` = DATE_ADD(`recorded_at`, INTERVAL 330 MINUTE);   -- 2 rows
UPDATE `store_delivery_sessions` SET
      `started_at` = DATE_ADD(`started_at`, INTERVAL 330 MINUTE),
      `ended_at` = DATE_ADD(`ended_at`, INTERVAL 330 MINUTE);   -- 3 rows
UPDATE `store_delivery_wallet_txns` SET
      `created_at` = DATE_ADD(`created_at`, INTERVAL 330 MINUTE);   -- 6 rows
```

### Check it worked

```sql
-- Delivery orders should now sit within minutes of their legacy counterparts,
-- not 5h30m apart. Expect a small number, not ~330.
SELECT ROUND(AVG(ABS(TIMESTAMPDIFF(MINUTE, d.offered_at, o.order_received_time))), 1)
         AS avg_minutes_apart
  FROM store_delivery_orders d
  JOIN store_orders o ON o.order_id = d.source_order_id
 WHERE d.offered_at IS NOT NULL;
```

---

## Section 2 — vendor data cleanup  (OPTIONAL, read the notes)

Current state, audited read-only:

| | vendor 20210 | vendor 20212 |
| --- | --- | --- |
| `business_status` | 1 (open) | **0 (closed)** |
| `business_open` / `business_close` | **00:00 / 03:59** | **null / null** |
| `business_menu_types` | **`'1219,'`** | **`''`** |
| `user_status` / `user_active` | 1 / 1 | 1 / 1 |
| `user_zip` | 452010 | 452010 |

### 2a. Vendor 20210's opening hours

`00:00`–`03:59` means the shop is open midnight to 4am and closed all day. This
is why it disappears from the storefront outside those hours.

**I did not guess the real hours** — only you know them. Replace the two values:

```sql
UPDATE `store_users_business`
   SET `business_open`  = '09:00:00',
       `business_close` = '23:00:00'
 WHERE `user_id` = 20210;
```

### 2b. Vendor 20210's trailing comma

`business_menu_types` is `'1219,'`. That trailing comma is the exact bug that
produced `Unknown column 'NaN'` and broke `/menu` for every customer. The
parser in `controllers/products.js` now filters non-integers so it can no
longer break anything, but the data is still malformed:

```sql
UPDATE `store_users_business`
   SET `business_menu_types` = '1219'
 WHERE `user_id` = 20210;
```

### 2c. The junk menu category — RENAME, do not delete

`menu_id = 1219` is `dfyvgvu` / `gjhbhjbhk` / keywords `gvbhiuk`, owned by
`menu_user_id = 20210`.

**It is not orphaned garbage.** It is the only category vendor 20210 has, and
their `business_menu_types` points at it. Deleting it leaves that vendor with
no categories at all, which is worse than a silly name.

```sql
UPDATE `store_menu`
   SET `menu_name`        = 'Main Course',
       `menu_title`       = 'Main Course',
       `menu_slug`        = 'main-course',
       `menu_keywords`    = 'main course',
       `menu_description` = 'Main course dishes'
 WHERE `menu_id` = 1219;
```

### 2d. Vendor 20212 is inert

Closed, no hours, no menu categories. Three separate reasons it can never
appear, so fixing one changes nothing.

Decide first whether this vendor should exist at all — if it was a duplicate
test row, leaving it closed is the correct outcome and you should skip this.
To bring it live it needs a real category id in `business_menu_types` (create
the category first, then reference it):

```sql
UPDATE `store_users_business`
   SET `business_status`     = 1,
       `business_open`       = '09:00:00',
       `business_close`      = '23:00:00',
       `business_menu_types` = '<a real menu_id>'
 WHERE `user_id` = 20212;
```
