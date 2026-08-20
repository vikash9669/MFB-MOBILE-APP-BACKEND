# Rate limiting

Implemented in [middlewares/rateLimit.js](middlewares/rateLimit.js). **On by
default** — nothing needs configuring for the caps to apply.

## What it protects and why

Two different risks, counted two different ways.

**Spend.** Sending an OTP costs a real Twilio/MSG91 message. An unlimited
`/auth/get-otp` is somebody else's hand in your account, and the cost is
identical whether the request was legitimate. So these count **every call**.

**Secrets.** Checking an OTP or a password is free to serve but guesses a
secret. Counting successes here would lock out the one caller we know is *not*
attacking — the person who typed their password correctly. So these count
**failures only**, and a success clears the count outright.

Getting that backwards is not theoretical: the first version of this shipped
with four of the seven guards counting every call, and twenty consecutive
*correct* OTP entries locked the account. `test/rateLimit.test.js` now asserts
the mode of every shipped limiter, not just the factory that builds them.

## The caps

| Endpoint | Bucket | Default | Counts |
| --- | --- | --- | --- |
| `POST /auth/get-otp`<br>`POST /delivery/auth/get-otp` | phone | 5 / 15 min | every call |
| ″ | IP | 20 / 15 min | every call |
| `POST /auth/verify-otp`<br>`POST /delivery/auth/verify-otp`<br>`POST /admin/auth/verify-otp`<br>`POST /admin/auth/reset-password` | phone | 8 / 15 min | failures |
| `POST /admin/auth/login` | account | 8 / 15 min | failures |
| ″ | IP | 30 / 15 min | failures |
| `PUT /admin/auth/password` | account | 8 / 15 min | failures |
| `POST /admin/auth/register` | IP | 5 / 60 min | every call |
| `POST /admin/auth/forgot-password` | phone + IP | as OTP send | every call |
| `x-admin-key` on `/delivery/admin/*`, `/notify/push` | IP | 10 / 15 min | failures |
| `POST /delivery/orders/:id/verify-pickup`<br>`POST /delivery/orders/:id/verify-delivery` | rider | 10 / 15 min | failures |
| `POST /delivery/auth/refresh` | IP | 60 / 15 min | failures |
| `GET /places/*` (customer app) | customer | 120 / 10 min | every call |
| `GET /admin/places/*` (panel picker) | IP | 40 / 10 min | every call |

Blocked callers get `429` with a `Retry-After` header and a `retry_after`
field, so a client can back off instead of spinning.

### Details worth knowing

- **The two apps share one phone bucket.** The customer app and the partner app
  both post to their own `/get-otp`, but it is the same handset and the same
  SMS bill. Separate buckets would double the cap for free.
- **Phone numbers are normalised** to the last 10 digits, so `9669901922`,
  `+91 96699 01922` and `919669901922` are one bucket, not three allowances.
- **Usernames are case-folded**, so `Admin@MFB.com` cannot dodge the bucket
  that `admin@mfb.com` filled.
- **`x-admin-key` lockout is IP-wide** and there is no account behind it to
  unlock. A script sharing an IP with a guesser gets caught in it. That is the
  cost of a single shared secret; the panel is unaffected because it uses its
  own JWT.
- **Our own 5xx never counts.** If the OTP provider is down, every verify 500s;
  counting those would lock out every user for the length of the outage, on top
  of the outage.

## Configuration

Copy this block into `.env.example` and `.env`. Every line is optional —
omitting them keeps the defaults above. (I could not append it to
`.env.example` myself; this workspace blocks writing to `.env*`.)

```dotenv
# ── Rate limiting (middlewares/rateLimit.js) ─────────────────────────
# All optional. Unset keeps the built-in defaults, which are already ON.

# Set ONLY when something in front of Node rewrites X-Forwarded-For (nginx, a
# load balancer). Without it, every caller behind the proxy shares one bucket.
# With it set while nothing strips the header, a caller can name their own IP
# and mint a fresh allowance per request — worse than one shared bucket.
# "1" is right for a single proxy; "true" or "loopback" also work.
TRUST_PROXY=

# Emergency off switch for all of it. Unset means ON.
RATE_LIMIT_DISABLED=false

OTP_SEND_WINDOW_MIN=15
OTP_SEND_MAX_PER_PHONE=5
OTP_SEND_MAX_PER_IP=20

OTP_VERIFY_WINDOW_MIN=15
OTP_VERIFY_MAX=8

LOGIN_WINDOW_MIN=15
LOGIN_MAX_PER_ACCOUNT=8
LOGIN_MAX_PER_IP=30

REGISTER_WINDOW_MIN=60
REGISTER_MAX_PER_IP=5

ADMIN_KEY_WINDOW_MIN=15
ADMIN_KEY_MAX_FAILURES=10

DELIVERY_CODE_WINDOW_MIN=15
DELIVERY_CODE_MAX_FAILURES=10

REFRESH_WINDOW_MIN=15
REFRESH_MAX_PER_IP=60

PLACES_LOOKUP_WINDOW_MIN=10
PLACES_LOOKUP_MAX=120
PLACES_RATE_LIMIT=40
```

### `TRUST_PROXY` is the one you must not forget in production

Every per-IP cap reads `req.ip`, which Express takes from the socket unless it
is told a proxy sits in front. Behind nginx that makes every caller look like
nginx: the caps still hold, but they stop distinguishing anybody, so one busy
customer can exhaust the shared IP allowance for everyone. Set it as soon as
there is a reverse proxy — and not before, because trusting `X-Forwarded-For`
while nothing strips it lets a caller spoof a new IP per request and bypass the
per-IP limits entirely.

## Known limitation: in-process, per-instance

State lives in a bounded `Map` in each Node process. Two backends behind a load
balancer each get their own allowance, and a restart forgets everything.

This is a real weakness against a determined attacker and an acceptable one
against what is actually happening today: someone spraying `/auth/get-otp`
until the Twilio bill hurts, and someone walking a 6-digit OTP or a plaintext
password list. Redis is the upgrade when there is more than one instance — the
call sites do not change when it arrives, only the store inside
`createLimiter`.

## Related, and still open

Rate limiting reduces the damage from plaintext passwords in `store_users`; it
does not fix it. A database leak is still an immediate credential leak. See the
warning at the top of [controllers/admin/auth.js](controllers/admin/auth.js)
and [ADMIN_PANEL_MIGRATION.md](ADMIN_PANEL_MIGRATION.md).
