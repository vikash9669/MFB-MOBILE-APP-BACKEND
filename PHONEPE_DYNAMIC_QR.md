# Doorstep payments: real UPI QR vs. hosted checkout

When a COD customer wants to pay online at the door, the rider shows a QR. What
that QR *contains* decides whether the customer pays in two taps or goes on a
detour through a web page.

## Why there are two PhonePe integrations

PhonePe sells the online and in-store products separately, and they do not
share credentials, endpoints, auth, or even transaction ledgers.

| | `util/phonepe.js` | `util/phonepeDqr.js` |
| --- | --- | --- |
| Product | PG Standard Checkout v2 | Offline **Dynamic QR** |
| Auth | OAuth → `O-Bearer` token | `X-VERIFY` SHA256 salt checksum |
| Host (UAT) | `api-preprod.phonepe.com/apis/pg-sandbox` | `mercury-uat.phonepe.com/enterprise-sandbox` |
| Host (prod) | `api.phonepe.com/apis/pg` | `mercury-t2.phonepe.com` |
| Returns | a hosted checkout **URL** | `qrString` — a real `upi://pay?pa=…&am=…` |
| Used for | app + web checkout | the QR a rider shows at a doorstep |

The PG product **cannot** produce a payment QR. This was tested against the live
UAT merchant rather than assumed — both `PG + UPI_QR` and `PG + UPI_INTENT` are
accepted by the API and both return only:

```
response keys: orderId, state, expireAt, redirectUrl
```

No `upi://` string in either. A QR of that `redirectUrl` opens a web page, which
is what made the rider's QR send customers to a merchant checkout instead of a
payment screen.

## Turning the real QR on

Set these and restart. Until they are all present `isConfigured()` is false and
collection silently falls back to the hosted-checkout URL — the previous
behaviour — so a half-filled config degrades instead of failing at a doorstep.

| Key | Notes |
| --- | --- |
| `PHONEPE_DQR_SALT_KEY` | From the PhonePe **offline** merchant onboarding. Not the PG client secret. |
| `PHONEPE_DQR_SALT_INDEX` | Usually `1`. |
| `PHONEPE_DQR_STORE_ID` | Required by PhonePe. One logical store for the whole fleet is fine — the rider is the terminal, not the store, and per-order attribution comes from `transactionId`. |
| `PHONEPE_DQR_MERCHANT_ID` | Optional. Defaults to `PHONEPE_MERCHANT_ID`; set it only if offline onboarding gave you a different id. |
| `PHONEPE_DQR_TERMINAL_ID` | Optional. |
| `PHONEPE_DQR_CALLBACK_URL` | Optional but recommended: `https://<public-host>/payment/phonepe/qr-callback`. Without it, payment is still detected by polling — just slower. |

`PHONEPE_ENV` (`UAT`/`PROD`) is shared with the PG client and picks the host for
both.

## How payment is detected

Three independent paths, all landing on the same idempotent `settleCollection`,
whose order flip is a single conditional `UPDATE … WHERE status = 'PENDING'`.
Whichever notices first wins; the rest are no-ops.

1. **The rider's screen** polls `/delivery/orders/:id/collect/status` every 3s.
2. **The callback** at `POST /payment/phonepe/qr-callback`, verified by
   `X-VERIFY` and then *re-checked* against the status API — a valid signature
   proves the message came from PhonePe, not that it is current, so a replayed
   callback cannot settle anything on its own say-so.
3. **`util/paymentSweeper.js`** re-reconciles every 60s, for the case where the
   rider closes the screen and the callback never arrives.

`statusFor(intent)` picks which product to ask, based on whether the stored
payload is a `upi://` string. This matters more than it looks: the two products
keep **separate ledgers**, so asking the wrong one returns "unknown
transaction" and the money looks unpaid for ever.

## Things PhonePe imposes that the code works around

- **`transactionId` charset** is narrower than our merchant txn ids —
  alphanumerics plus `-` and `_`, max 35 chars. `safeTransactionId()` enforces
  it, because a rejected character costs a payment at a doorstep.
- **Each QR is single-use.** Once a customer has *started* paying against it, it
  cannot be scanned again; a retry needs a fresh `transactionId`.
- **Amounts are in paise**, as everywhere else in PhonePe.

## The rider never marks a payment received

There is deliberately no "mark as paid" button on `CollectPaymentScreen`. The
screen polls and the backend asks PhonePe. A button there would be a rider
tapping it, keeping the cash, and the shortfall surfacing days later in float
reconciliation — the exact fraud the QR exists to remove. For the same reason
`settleCollection` never credits `dp_cash_in_hand`: the money went to PhonePe,
not the rider's pocket.
