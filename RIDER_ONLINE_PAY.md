# Rider online time, shifts and online pay

How the delivery-partner app measures a rider's online time, how shifts are
marked completed, and how ₹10 per online hour reaches the wallet.

## Rules (agreed 15 Sept 2026)

| Rule | Decision |
| --- | --- |
| What is paid | **All online time**, ₹10/hour, on top of delivery earnings. Shifts do not affect pay. |
| Partial hours | Pro-rata per whole minute: 45 min = ₹7.50, 12 h = ₹120. |
| When credited | Once a day, after midnight IST, for the previous day. Late-synced data is paid as a top-up. |
| Short gaps | A gap of **≤ 5 min** between location samples counts as online. A longer gap is offline from the last sample to the next. |
| What "offline" means | No location samples (location off, app closed) **or no internet** for more than 5 min. Up to 5 min without internet counts; beyond that the whole outage is offline even though the phone kept recording and synced it later. (Agreed 15 Sept 2026.) |
| Sampling | Location every **5 s** while the rider is online. Stored on the phone while offline, sent when back online. |
| Shifts | A rider's declared availability, shown to admins. Marked completed from measured online time, with the offline minutes inside the window. |

## What existed before, and the gaps

| Piece | State found |
| --- | --- |
| Shift booking (`POST /delivery/shifts`) | Works. Shifts stayed `booked` forever — nothing set `active`/`completed` or `worked_min`. |
| Online sessions (`store_delivery_sessions`) | Opened/closed by the online toggle; closed by `sessionSweeper` after 5 min without a point. |
| Location from the app while online | Once a minute (`App.tsx` → `startShiftTracking`), foreground only; a failed push was dropped. |
| Background tracking | **Missing.** No foreground service, so JS timers stop when the app is backgrounded. Notifee's own service is declared `shortService`, which Android 14+ stops after ~3 min. |
| Offline buffering | **Missing.** A failed push was dropped. |
| Late data | **Impossible.** The 5-min rule judged arrival time on the server, so a backlog could never repair history. |
| Online pay | **Missing.** Only delivery earnings and withdrawals touched the wallet. |
| `dp_location_at` | **Never written**, so dispatch's stale-location filter and `riderLocationSweeper` never acted. |
| ₹150 daily bonus | Notification only, never credited (out of scope here, noted). |

## Design

### Source of truth: device-timestamped samples → presence spans

The server cannot judge presence by *when data arrives* — a rider in a tunnel
is online but silent. So every sample carries the phone's own time, and the
server rebuilds presence from those times, in whatever order they arrive.

Raw 5-second samples are **not stored** (17,280 rows per rider per day on
shared MySQL). Each sample is folded into a **presence span**:

```
store_rider_presence_spans(span_id, dp_id, start_ms, end_ms, samples,
                           end_reason, start/end lat-lng)
```

Folding a fix at time `t` (pure function, `util/presence/spans.js`):

* joins every span it lies within 5 min of, merging two spans it bridges;
* never extends a span past an explicit **go-offline** (`end_reason='offline'`);
* otherwise starts a new span.

This is order-independent, so a backlog synced after newer live data lands in
the right place. Online time for any window is the overlap of spans with it.

### Internet outages

A sample recorded without internet and uploaded later looks like any other, so
the server cannot see an outage in the samples. The phone reports it: it
remembers the last moment the server answered (persisted, so a restart
mid-outage keeps it), and on reconnecting queues
`{ kind: "net", t: reconnected, lost_at }` **after** the backlog.

* Outage ≤ 5 min — ignored; the backlog counts as normal.
* Outage > 5 min — stored as a `blackout` row over `[lost_at, reconnected]`.
  Online time is cut out of every span it overlaps, and any fix inside it is
  ignored, including one that arrives later from a retried upload. Folding the
  same outage twice changes nothing. Blackout rows are never counted as
  presence (pay, shifts, totals, "online now").

Times are stored as epoch milliseconds (`BIGINT`) — no timezone conversion
anywhere between phone, Node and MySQL (`DB_TIMEZONE` is +05:30).

### Clock trust

A phone's clock can be wrong. Each upload carries the phone's current time;
the server measures the skew and corrects every sample in the batch. Samples
in the future (> 2 min) or older than the backfill window (72 h) are refused.

### Transport: WebSocket, with an HTTP fallback

* **WebSocket** `GET /delivery/presence/ws` (the `ws` package on the existing
  HTTP server). Live samples go up as they are taken; the server replies
  `ack` with the highest sequence stored, and the phone deletes only acked
  samples. One persistent connection costs far less battery and data than an
  HTTP request every 5 s, and a dropped connection is noticed immediately.
* **HTTP** `POST /delivery/presence/samples` — the same ingest, used when the
  socket cannot connect (proxies, captive portals) and by tests.

Auth is the rider's normal access token, sent in the first message (not the
URL, which proxies log). An expired token closes the socket with 4001; the app
refreshes and reconnects.

WebSocket was chosen over SSE (one-way only) and socket.io (heavier, sticky
sessions). The connection holds no state the database does not also have, so
multiple backend instances work.

### Phone (delivery-partner app)

* **Tracker** — while online: a location watch plus a 5-s ticker. A fresh fix
  becomes a sample; no fix means no sample and the "Location is off" alert.
* **Queue** — samples persisted in AsyncStorage in chunks, capped at 72 h.
  Survives the app being killed.
* **Uploader** — WebSocket first, HTTP fallback, backlog in batches of 500,
  exponential reconnect.
* **Android foreground service** (notifee, type `location`) with a persistent
  "You're online" notification, so tracking continues with the screen off or
  another app open.
* Explicit **online / offline events** are queued too, so tapping offline ends
  the span at once rather than 5 minutes later.
* On launch, if the server says the rider is online, tracking resumes.

### Online status on the server

* A fresh sample for a rider marked offline marks them online again (they
  reconnected within the rules).
* `sessionSweeper` still marks a rider offline after 5 min without a sample.

### Daily online pay

`util/presence/onlinePay.js`, run hourly:

1. For each IST day from 3 days ago to yesterday that ended ≥ 30 min ago,
   total each rider's online minutes inside `[00:00, 24:00)` IST.
2. `amount = minutes × ₹10 / 60`, in paise.
3. Ledger `store_rider_online_pay(dp_id, pay_date, online_min, paid_paise)`,
   unique on `(dp_id, pay_date)`. Only the **difference** from what was
   already paid is credited. A second run pays nothing; data synced late pays
   a top-up.
4. The wallet entry, the balance increment and the ledger update commit in one
   transaction with a row lock, so two backend instances cannot double-pay.

Rate and switches are env-tunable: `RIDER_ONLINE_PAY_PER_HOUR` (10),
`RIDER_ONLINE_PAY_ENABLED` (true), `PRESENCE_GAP_MIN` (5),
`PRESENCE_BACKFILL_HOURS` (72).

### Shift completion (admin availability view)

For shifts whose window has passed (last 3 days), the same job writes
`worked_min`, `offline_min`, `status='completed'` and
`completion = full | partial | missed`:

* `full` — offline inside the window ≤ 5 min;
* `missed` — no online time inside the window;
* `partial` — anything between.

A running shift is shown `active`, computed live on read.

## Test plan

1. **Unit** — span folding (gaps, bridging, offline barrier, out-of-order),
   day clipping across midnight IST, per-minute pay, top-up delta, skew
   correction, shift completion.
2. **Integration on the local sandbox DB** (never the shared clone) — a
   simulated phone over WebSocket: live samples, a 3-min gap (counts), a 7-min
   gap (does not), explicit offline, an offline backlog synced later, HTTP
   fallback, token expiry; then the pay job twice (idempotent) and after a
   late sync (top-up).
3. **Emulator, rider app against the sandbox backend** — samples every 5 s;
   airplane mode for 2 min then back (backlog synced, no gap); location off
   for 7 min (offline gap); app in background (still tracking); app
   force-stopped for 6 min (offline, then resumes).
