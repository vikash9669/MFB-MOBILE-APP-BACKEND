const crypto = require("crypto");
const axios = require("axios");

// Cashfree Payment Gateway client — API version 2026-01-01.
//
// Written against the interface util/gateway.js presents, not called directly:
// every caller — controllers/payment.js, util/codCollection.js,
// util/paymentSweeper.js, util/orderLifecycle.js — goes through the gateway
// module. It is the only driver now, but the shape is what kept removing the
// previous one a single-file change.
//
//   auth      Two headers on every request (x-client-id / x-client-secret).
//             No OAuth dance, so no token cache to keep warm or invalidate.
//
//   amounts   RUPEES, with up to two decimals — NOT paise. Gateways in this
//             market differ on this and some bill in paise, so any *100
//             conversion copied in from elsewhere overcharges by 100x. This is
//             the single easiest way to take a hundred times a customer's
//             money, and it looks correct in every log until they complain.
//
//   identity  Cashfree calls our id `order_id`. It is our merchant_txn_id.
//
//   flow      Create Order returns a `payment_session_id`. The mobile SDK and
//             the web JS SDK both consume that directly, so there is no
//             separate "hosted checkout returns a redirect URL" call.
//             createHostedCheckout below returns the session id and the browser
//             hands it to Cashfree's JS SDK.
//
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create

const API_VERSION = "2026-01-01";

const HOSTS = {
  UAT: { api: "https://sandbox.cashfree.com/pg", sdk: "SANDBOX" },
  PROD: { api: "https://api.cashfree.com/pg", sdk: "PRODUCTION" },
};

const config = () => {
  // Spelled the same way every other *_ENV in this service is, so "this is
  // production" reads identically wherever it appears.
  const env =
    (process.env.CASHFREE_ENV || "UAT").toUpperCase() === "PROD" ? "PROD" : "UAT";
  return {
    env,
    ...HOSTS[env],
    clientId: process.env.CASHFREE_CLIENT_ID || "",
    clientSecret: process.env.CASHFREE_CLIENT_SECRET || "",
  };
};

const isConfigured = () => {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
};

const headers = () => {
  const { clientId, clientSecret } = config();
  return {
    "Content-Type": "application/json",
    "x-api-version": API_VERSION,
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
  };
};

// 4xx from Cashfree carries a structured reason worth recording rather than
// throwing away behind a generic axios error.
const softStatus = (s) => s >= 200 && s < 500;

// Cashfree requires a customer_id and a 10-digit customer_phone on every order.
// Callers know the user id; the phone has to be looked up, and is not always
// present on legacy rows. A placeholder keeps checkout working rather than
// failing an otherwise good order — Cashfree only uses it for its own receipts,
// and the payment itself is identified by order_id.
const PLACEHOLDER_PHONE = "9999999999";

const customerBlock = ({ userId, customer = {} }) => {
  const digits = String(customer.phone || "").replace(/\D/g, "").slice(-10);
  const block = {
    customer_id: String(customer.id ?? userId ?? "guest").slice(0, 50),
    customer_phone: digits.length === 10 ? digits : PLACEHOLDER_PHONE,
  };
  // Both optional. Sent only when real, so Cashfree does not email a
  // fabricated address.
  if (customer.email && !/@example\.(com|org)$/i.test(customer.email)) {
    block.customer_email = String(customer.email).slice(0, 100);
  }
  if (customer.name) block.customer_name = String(customer.name).slice(0, 100);
  return block;
};

/**
 * Creates the order every other call hangs off.
 *
 * `order_id` is our merchant_txn_id. Cashfree constrains it to 3-45 characters
 * of alphanumerics, underscore and hyphen — which the MFB<timestamp><user><hex>
 * format in controllers/payment.js already satisfies.
 *
 * Returns the payment_session_id that both SDKs consume.
 */
const createOrder = async ({
  merchantOrderId,
  amountInRupees,
  userId,
  customer,
  returnUrl,
  notifyUrl,
  expiryMinutes = 20,
}) => {
  const { api } = config();

  const order_meta = {};
  if (returnUrl) order_meta.return_url = returnUrl;
  // Must be public HTTPS. On a host Cashfree cannot reach, the reconciliation
  // sweeper is the only thing that will ever settle the payment.
  if (notifyUrl && /^https:\/\//i.test(notifyUrl)) order_meta.notify_url = notifyUrl;

  const body = {
    order_id: merchantOrderId,
    // RUPEES. See the header note — do not multiply by 100.
    order_amount: Number(Number(amountInRupees).toFixed(2)),
    order_currency: "INR",
    customer_details: customerBlock({ userId, customer }),
    order_expiry_time: new Date(Date.now() + expiryMinutes * 60_000).toISOString(),
  };
  if (Object.keys(order_meta).length) body.order_meta = order_meta;

  const { data, status } = await axios.post(`${api}/orders`, body, {
    headers: headers(),
    timeout: 20000,
    validateStatus: softStatus,
  });

  if (status >= 400 || !data?.payment_session_id) {
    throw new Error(
      `Cashfree order creation failed (${status}): ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return {
    orderId: data.order_id,
    cfOrderId: data.cf_order_id,
    sessionId: data.payment_session_id,
    expireAt: data.order_expiry_time ?? null,
  };
};

// The mobile apps' entry point. Named for the gateway interface so
// util/gateway.js can hand either to the same controller.
const createSdkOrder = async (args) => {
  const order = await createOrder(args);
  return {
    orderId: order.orderId,
    // Cashfree's RN SDK takes a session id, not a token.
    // Reported under both names so a caller written for either works.
    token: order.sessionId,
    sessionId: order.sessionId,
    expireAt: order.expireAt,
  };
};

/**
 * The browser's entry point.
 *
 * There is no server-issued redirect URL: Cashfree's web SDK
 * takes the session id and performs the redirect itself. So this returns a
 * session rather than a location, and the storefront branches on `provider`.
 */
const createHostedCheckout = async ({ redirectUrl, ...rest }) => {
  const order = await createOrder({ ...rest, returnUrl: redirectUrl });
  return {
    orderId: order.orderId,
    sessionId: order.sessionId,
    // Explicitly null so a caller that blindly reads redirectUrl gets an
    // obvious absence rather than undefined.
    redirectUrl: null,
    expireAt: order.expireAt,
  };
};

// Per-attempt outcomes, from Cashfree's payment_status vocabulary.
//
// IN_FLIGHT is the only set that justifies telling a customer "your payment is
// still being confirmed — do not pay again". Everything in ATTEMPT_DEAD is over,
// no money moved, and the honest answer is "that didn't work, try again".
const ATTEMPT_IN_FLIGHT = new Set(["PENDING"]);
const ATTEMPT_DEAD = new Set(["FAILED", "USER_DROPPED", "CANCELLED", "VOID"]);

// NOT_ATTEMPTED is deliberately in NEITHER set: it is a placeholder row, not an
// outcome. Cashfree stamps one on an order as soon as it is created, before
// anybody has touched it.
//
// Counting it as a finished attempt made "all attempts are dead" true the
// instant an order existed, so every doorstep QR was marked FAILED by the first
// status poll after it was raised — and the next request opened a second
// payment link for the same delivery. Caught in the sandbox, not by any unit
// test, because only the real API returns these rows.
const ATTEMPT_NOT_STARTED = new Set(["NOT_ATTEMPTED"]);

/** Attempts that represent something actually having been tried. */
const realAttempts = (attempts) =>
  attempts.filter((p) => !ATTEMPT_NOT_STARTED.has(p?.payment_status));

// How long an order with NO attempt on it at all is still given the benefit of
// the doubt.
//
// Sized against what this window actually protects, which is narrower than it
// first looks. Money cannot move without Cashfree recording an attempt, and a
// UPI request sitting unanswered in someone's bank app IS an attempt — a
// PENDING one, caught by the check above. So the only thing left to cover here
// is the few seconds between Cashfree accepting a payment and its API showing
// it. A minute is generous for that.
//
// Longer would be worse, not safer: an order with no attempt on it is one the
// customer abandoned, and every extra second of grace is a second they spend
// looking at "confirming your payment" with checkout disabled.
const NO_ATTEMPT_GRACE_MS = Number(process.env.CASHFREE_NO_ATTEMPT_GRACE_MS || 60_000);

/** The attempts on an order. Best-effort: [] rather than throwing. */
const listPayments = async (merchantOrderId) => {
  const { api } = config();
  try {
    const { data } = await axios.get(
      `${api}/orders/${encodeURIComponent(merchantOrderId)}/payments`,
      { headers: headers(), timeout: 15000, validateStatus: softStatus }
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.log("MFB ~ cashfree ~ payments lookup ~", err.message);
    return [];
  }
};

/**
 * Whether an unpaid order still has something happening on it.
 *
 * Deliberately conservative in one direction only: when the payments list is
 * unavailable we fall back to the grace window rather than declaring failure,
 * because telling someone a payment failed when it is in flight invites a second
 * charge. The opposite mistake — a stuck "confirming" screen — only costs a
 * retry.
 */
const isStillInFlight = (state, attempts, order, graceMs = NO_ATTEMPT_GRACE_MS) => {
  if (state !== "ACTIVE") return false;
  if (attempts.some((p) => ATTEMPT_IN_FLIGHT.has(p?.payment_status))) return true;
  // Something was really tried and every attempt is finished: not in flight.
  // Placeholder rows do not count — see ATTEMPT_NOT_STARTED.
  if (realAttempts(attempts).length > 0) return false;

  const createdAt = Date.parse(order?.created_at ?? "");
  if (!Number.isFinite(createdAt)) return true; // unknown age — assume in flight
  return Date.now() - createdAt < graceMs;
};

/**
 * Server-side truth for an order.
 *
 * Two calls, because they answer different questions and Cashfree splits them:
 * the order says whether it is PAID, the payments list says which attempt did
 * it, by what instrument, and — crucially — whether anything is still running.
 */
const fetchStatus = async (merchantOrderId, { noAttemptGraceMs } = {}) => {
  const { api } = config();

  const { data, status } = await axios.get(
    `${api}/orders/${encodeURIComponent(merchantOrderId)}`,
    { headers: headers(), timeout: 15000, validateStatus: softStatus }
  );

  if (status >= 400) {
    return {
      raw: data,
      success: false,
      pending: false,
      state: "UNKNOWN",
      providerTxnId: null,
      instrument: null,
      message: data?.message || `HTTP ${status}`,
    };
  }

  const state = data?.order_status || "UNKNOWN";
  const success = state === "PAID";

  let providerTxnId = null;
  let instrument = null;
  let message = state;

  // The payments list is fetched for ACTIVE as well as PAID, and that is the
  // whole point of this function.
  //
  // ACTIVE only means "no successful payment yet". It covers two situations
  // that could not be more different to a customer: money genuinely in flight
  // at their bank, and a checkout sheet they opened and backed out of. Treating
  // both as PENDING is what produced the bug this replaces — a customer who
  // dismissed the Cashfree sheet came back to "Payment is still being confirmed
  // by the bank... do not pay again", with Pay Now disabled. They had not paid,
  // no money was moving, nothing would ever arrive to confirm, and the cart was
  // unusable until the intent aged out. Reproduced from the customer app.
  //
  // order_status cannot tell them apart; per-attempt payment_status can.
  const attempts = await listPayments(merchantOrderId);

  if (success) {
    const paid = attempts.find((p) => p?.payment_status === "SUCCESS");
    if (paid) {
      providerTxnId = String(paid.cf_payment_id ?? "") || null;
      instrument = paid.payment_group || null;
      message = paid.payment_message || state;
    }
  }

  const pending = success ? false : isStillInFlight(state, attempts, data, noAttemptGraceMs);
  if (!success && !pending && state === "ACTIVE") {
    // Say why, so the customer is told "that didn't go through, try again"
    // rather than being left to guess.
    const dropped = attempts.find((p) => ATTEMPT_DEAD.has(p?.payment_status));
    message = dropped?.payment_message || (realAttempts(attempts).length === 0
      ? "Payment was not completed"
      : "Payment attempt did not succeed");
  }

  return {
    raw: data,
    success,
    pending,
    state,
    // Falls back to our own id so a settled order always records something.
    providerTxnId: providerTxnId || (success ? String(data?.cf_order_id ?? "") || null : null),
    instrument,
    message,
    // What the gateway says this order is worth, in RUPEES. Settlement compares
    // it against the amount we quoted before creating anything.
    amountInRupees: Number.isFinite(Number(data?.order_amount))
      ? Number(data.order_amount)
      : null,
  };
};

/**
 * A real UPI QR for taking a COD order's money at the door.
 *
 * This is the doorstep-QR path, and the reason that
 * file exists: an ordinary checkout call can only produce a hosted-checkout URL,
 * which encodes into a QR that opens a web page rather than a UPI app. Here the
 * `podQrCode` channel — Cashfree's own name for pay-on-delivery — returns a
 * scannable QR, and `qrcode` is tried as a fallback for accounts where the POD
 * channel is not enabled.
 *
 * IMPORTANT: /orders/sessions is Cashfree's server-to-server endpoint and is
 * gated behind the S2S flag on the merchant account. Without it every call
 * here fails, so this returns null and the caller falls back to the ordinary
 * checkout link, which still collects the money.
 */
const createUpiQr = async ({ merchantOrderId, amountInRupees, userId, customer, notifyUrl }) => {
  const { api } = config();

  const order = await createOrder({
    merchantOrderId,
    amountInRupees,
    userId,
    customer,
    notifyUrl,
  });

  // Extra headers only this endpoint demands.
  const s2sHeaders = {
    ...headers(),
    "x-client-device": "mobile",
    "x-client-os": "android",
    "x-client-rendering-type": "native",
  };

  for (const channel of ["podQrCode", "qrcode"]) {
    try {
      const { data, status } = await axios.post(
        `${api}/orders/sessions`,
        {
          payment_session_id: order.sessionId,
          payment_method: { upi: { channel } },
        },
        { headers: s2sHeaders, timeout: 20000, validateStatus: softStatus }
      );

      if (status >= 400) {
        console.log(
          `MFB ~ cashfree ~ upi qr (${channel}) ~ ${status}: ` +
            `${data?.code || data?.message || "refused"}`
        );
        continue;
      }

      const d = data?.data || {};
      // Verified against the live sandbox, which answers:
      //
      //   data.payload.link    the payment string a QR should encode
      //   data.payload.qrcode  the same thing already rendered, as a
      //                        "data:image/png;base64,…" URI
      //
      // In sandbox `link` is an https simulator URL carrying the UPI fields
      // (pa, pn, am, tr, cu); in production it is expected to be a real
      // `upi://pay?…` intent. Either way it is what gets encoded, and
      // util/codCollection.js decides how to describe it to the rider by
      // looking at the string itself rather than trusting a flag.
      const payload = d.payload;
      const qrString =
        typeof payload === "string"
          ? payload
          : payload?.upi || payload?.link || d.url || null;
      // Kept for callers that would rather show Cashfree's own rendering than
      // draw their own. Not persisted — a data URI is far too large for the
      // collect_url column, and a QR can be regenerated from the string.
      const qrImage = payload?.qrcode || d.base64_encoded_qr || d.qrcode || null;

      if (qrString || qrImage) {
        return {
          orderId: order.orderId,
          sessionId: order.sessionId,
          providerRef: data?.cf_payment_id ? String(data.cf_payment_id) : null,
          qrString,
          qrImageBase64: qrImage,
          channel,
        };
      }

      console.log(`MFB ~ cashfree ~ upi qr (${channel}) ~ no payload in response`);
    } catch (err) {
      console.log(`MFB ~ cashfree ~ upi qr (${channel}) ~`, err.message);
    }
  }

  return null;
};

/**
 * Refunds a completed payment, in full or in part.
 *
 * merchantRefundId is our idempotency key: Cashfree
 * treats a repeat of the same refund_id against the same order as the same
 * refund. Callers must persist the id BEFORE calling and reuse it on retry —
 * see util/orderLifecycle.js, which claims it with a unique index.
 *
 * Cashfree scopes refunds under the order, so this needs the
 * original order id as well as the refund id.
 */
const refundPayment = async ({ merchantRefundId, originalMerchantOrderId, amountInRupees }) => {
  const { api } = config();

  const { data, status } = await axios.post(
    `${api}/orders/${encodeURIComponent(originalMerchantOrderId)}/refunds`,
    {
      refund_id: merchantRefundId,
      refund_amount: Number(Number(amountInRupees).toFixed(2)),
      refund_note: "Order cancelled",
      refund_speed: "STANDARD",
    },
    { headers: headers(), timeout: 20000, validateStatus: softStatus }
  );

  const state = data?.refund_status || (status >= 400 ? "FAILED" : "UNKNOWN");
  // PENDING means accepted and on its way, not settled.
  const accepted = state === "SUCCESS" || state === "PENDING" || state === "ONHOLD";

  return {
    raw: data,
    accepted,
    state,
    refundId: data?.cf_refund_id ? String(data.cf_refund_id) : null,
    amount: data?.refund_amount ?? amountInRupees,
    message: data?.refund_note || data?.message || data?.code || state,
  };
};

/** Where a refund actually got to. Used by the reconciliation sweep. */
const fetchRefundStatus = async ({ merchantRefundId, originalMerchantOrderId }) => {
  const { api } = config();

  const { data, status } = await axios.get(
    `${api}/orders/${encodeURIComponent(originalMerchantOrderId)}/refunds/${encodeURIComponent(
      merchantRefundId
    )}`,
    { headers: headers(), timeout: 15000, validateStatus: softStatus }
  );

  const state = data?.refund_status || (status >= 400 ? "UNKNOWN" : "UNKNOWN");
  return {
    raw: data,
    state,
    completed: state === "SUCCESS",
    // ONHOLD and PENDING are still in flight; only these two are dead ends.
    failed: state === "FAILED" || state === "CANCELLED",
    message: data?.message || data?.code || state,
  };
};

/**
 * Webhook authenticity.
 *
 * base64(HMAC-SHA256(x-webhook-timestamp + RAW body, client secret)).
 *
 * The raw body matters: express.json() reparses and re-serialises, and the
 * bytes it produces are not necessarily the bytes Cashfree signed. app.js
 * stashes the original on req.rawBody via the json() verify hook, and this
 * refuses rather than guesses if it is missing.
 */
const verifyCallbackAuth = (req) => {
  const { clientSecret } = config();
  const signature = req?.headers?.["x-webhook-signature"];
  const timestamp = req?.headers?.["x-webhook-timestamp"];
  const rawBody = req?.rawBody;

  if (!clientSecret || !signature || !timestamp || typeof rawBody !== "string") {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(`${timestamp}${rawBody}`)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Pulls our order id and the reported state out of a webhook body. */
const parseCallback = (req) => {
  const body = req?.body || {};
  const merchantOrderId = body?.data?.order?.order_id ?? null;
  const state = body?.data?.payment?.payment_status ?? body?.type ?? null;
  return merchantOrderId ? { merchantOrderId, state } : null;
};

module.exports = {
  name: "cashfree",
  config,
  isConfigured,
  createOrder,
  createSdkOrder,
  createHostedCheckout,
  createUpiQr,
  fetchStatus,
  refundPayment,
  fetchRefundStatus,
  verifyCallbackAuth,
  parseCallback,
};
