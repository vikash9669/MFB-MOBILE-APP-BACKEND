# Delivery dispatch — how a customer order reaches a rider

Until now `store_orders` (customer app) and `store_delivery_orders` (partner app)
were two disconnected islands. Nothing created a delivery job except the demo
seeder, so a real rider could go online and never be offered a real order. This
document covers the bridge that closes that gap, and where every Google Maps key
belongs.

---

## Where the Google Maps API keys go

There are **three separate keys**, and they are not interchangeable — Google lets
a key carry only one restriction type, so an Android-restricted key returns
`REQUEST_DENIED` when the server calls it, and vice versa. Create them all in the
same Cloud project (`mfbapp-a4312`) so billing and quota stay in one place.

| # | Used by | File | Enable | Restrict to |
| --- | --- | --- | --- | --- |
| 1 | Delivery app, Android | `MFB-DELIVERY-PARTNER-APP/android/local.properties` | Maps SDK for Android | Android apps → `com.mfbdeliverypartner` + SHA-1 |
| 2 | **Backend** | `MFB-MOBILE-APP-BACKEND/.env` | **Geocoding API** | IP addresses → your server's egress IP |
| 3 | Delivery app, iOS | *not needed* | — | — |

**1 — Android app key.** Create the file if it doesn't exist (it's git-ignored):

```
GOOGLE_MAPS_API_KEY=AIzaSy...android-key...
```

`android/app/build.gradle` reads it into a manifest placeholder. Needs a full
native rebuild — a Metro reload won't pick it up. Full walkthrough in
[MAPS_SETUP.md](../MFB-DELIVERY-PARTNER-APP/MAPS_SETUP.md).

**2 — Backend server key.** Add to `.env`:

```
GOOGLE_MAPS_API_KEY=AIzaSy...server-key...
```

This one is **Geocoding API, not Maps SDK** — a different API that has to be
enabled separately, and it needs billing on the project. Restrict it by IP, and
if you deploy somewhere with rotating egress IPs (Render, Heroku), either pin an
outbound IP or leave it unrestricted *and* API-restricted to Geocoding only.

Leaving it blank is safe: jobs are still created, just with no coordinates. See
"What degrades without a key" below.

**3 — Delivery app, iOS.** Nothing to add. iOS renders through Apple MapKit,
which needs no key and no billing. A key is only needed if you deliberately
switch iOS to Google tiles — optional path documented in MAPS_SETUP.md.

**Customer app.** Nothing to add either — it has no map today. If you later add a
map picker at address entry, that's a fourth key, restricted to iOS/Android apps
with bundle id `com.myfirstbite`, plus `expo-location` / `react-native-maps` and
an EAS rebuild.

---

## How the bridge works

### Trigger

`runPostOrderSideEffects` in [util/orders.js](util/orders.js) calls
`queueDeliveryJob(order_id)`. Both checkout paths already funnel through it —
COD in `controllers/order.js` and PhonePe in `controllers/payment.js` — so one
hook covers both. The job is created at **order placement**, not when the
restaurant marks the food ready, because placement is the only server-side hook
that exists today; `order_status` transitions happen in the PHP admin panel,
which has no delivery integration at all.

If you later want riders offered only once a vendor accepts, move the
`queueDeliveryJob` call to wherever `order_status` becomes `1`/`2`.

### Building the job — [util/deliveryDispatch.js](util/deliveryDispatch.js)

1. **Endpoints.** The restaurant's address comes off its `store_users` row
   (`user_address`, `user_city`, `user_zip`, `user_phone`) — `store_users_business`
   holds no address at all. The customer's comes from the shipping address the
   order was placed against, including that address's own phone number.
2. **Geocoding.** Both ends go to the Google Geocoding API in parallel, with a
   `postal_code` components filter so "MG Road" resolves in the right city.
   Results are cached in-process (500 entries, FIFO) — the same restaurants and
   repeat addresses come round constantly and every lookup is billable.
3. **Distance.** Great-circle between the two points × 1.3 to approximate road
   distance. This is a heuristic, not a Directions API call — see below.
4. **Pay.** `base + max(0, km − freeKm) × perKm`, all three tunable from `.env`.
5. **Cash.** COD orders carry `cash_to_collect = order_amount + delivery − discount`;
   prepaid orders carry zero.
6. **OTPs.** Fresh six-digit pickup and drop codes per job.

Creation is **idempotent** on `source_order_id`, which matters because the
PhonePe callback can be re-entered on retries.

### Matching — [controllers/deliveryOrders.js](controllers/deliveryOrders.js)

`GET /delivery/orders/incoming` previously returned the single globally-oldest
open job to every rider in the country. It now:

- refuses to offer anything to an **offline** rider (`reason: "offline"`),
- excludes jobs the rider has already **rejected** — these used to come straight
  back on the next poll,
- ranks the 20 oldest open offers by **distance from the rider's last reported
  position** and returns the nearest within `DELIVERY_MAX_OFFER_KM`,
- fills in `pickup_distance_km` per rider at offer time (it's not stored, because
  it's different for every rider who sees the job),
- falls back to oldest-first when the rider has no GPS fix yet, and keeps
  un-geocoded jobs eligible but last, so they're never stranded in the pool.

This is the first time `dp_lat`/`dp_lng` are read for anything. The app has been
pushing them every 10–15 seconds since the location service was written.

---

## What degrades without a key

Nothing breaks. `util/geo.js` fails soft at every step — no key, an API error, or
an address Google can't place all return `null`.

| | With key | Without key |
| --- | --- | --- |
| Job created | yes | yes |
| Pickup/drop pins on the rider's map | yes | blank map, addresses still shown as text |
| `distance_km` / `eta_min` | real | `0` |
| Distance pay | real | base fare only |
| Nearest-first matching | yes | falls back to oldest-first |

So it's worth setting, but a missing key is a degraded service rather than an
outage.

---

## Config

All optional — the defaults are in the table.

| Key | Default | Meaning |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | *(blank)* | Server key, Geocoding API |
| `DELIVERY_EARN_BASE` | `25` | Base fare per job (₹) |
| `DELIVERY_EARN_PER_KM` | `6` | Per-km rate beyond the free distance (₹) |
| `DELIVERY_EARN_FREE_KM` | `2` | Distance included in the base fare |
| `DELIVERY_MAX_OFFER_KM` | `8` | Furthest pickup a rider is offered |

---

## Verifying it end to end

1. Set `GOOGLE_MAPS_API_KEY` and restart the backend.
2. Place an order from the customer app (COD is easiest).
3. Confirm a `store_delivery_orders` row appears with your `order_id` in
   `source_order_id`, and non-null `pickup_lat` / `drop_lat`.
4. On the partner app: go online, let it report a position, then **Check for
   orders** — the job should appear with a real distance and fare.
5. Reject it, then check again. It must **not** come back.
6. Accept, and run pickup → OTP → delivery → OTP. Earnings land in the wallet.

If step 3 shows null coordinates, check the backend log for
`MFB-error-logs ~ geocode ~ status:` — `REQUEST_DENIED` means the key is
restricted to apps rather than IPs, or the Geocoding API isn't enabled.

---

## Known limits

- **Straight-line distance, not routed.** Pay and ETA use a 1.3× padded
  great-circle figure. Switching to the Routes API would be more accurate but
  bills per request on every order; the padding is within a few percent for
  short urban hops, and worth revisiting if riders dispute pay.
- **No re-offer or expiry.** A job nobody accepts stays `offered` forever. There
  is no timeout, no escalation to a wider radius, and no cancellation path from
  the customer side.
- **No push on offer.** Riders still have to pull (tap "Check for orders"). The
  FCM plumbing exists — `notifyPartner` is already used for assignment — so
  pushing on job creation is a small follow-up.
- **The order status flows one way.** Delivery progress is not written back to
  `store_orders.order_status`, so the customer app still won't show "on the way".
