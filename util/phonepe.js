const crypto = require("crypto");
const axios = require("axios");

// PhonePe PG client — Standard Checkout **v2**, which is what
// react-native-phonepe-pg v3.x speaks.
//
// This is NOT the old v1 flow (base64 body + X-VERIFY salt checksum). v2 is:
//   1. OAuth   → POST /v1/oauth/token           (client_id + client_secret)
//   2. Order   → POST /checkout/v2/sdk/order    (returns orderId + token)
//   3. SDK     → app calls startTransaction({orderId, token, paymentMode})
//   4. Status  → GET  /checkout/v2/order/{merchantOrderId}/status
//
// The client secret stays server-side; the app only ever receives the
// short-lived per-order `token`, which is why initiate/confirm round-trip here.

const HOSTS = {
  UAT: {
    api: "https://api-preprod.phonepe.com/apis/pg-sandbox",
    oauth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
    sdk: "SANDBOX", // what PhonePePaymentSDK.init() expects
  },
  PROD: {
    api: "https://api.phonepe.com/apis/pg",
    oauth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
    sdk: "PRODUCTION",
  },
};

const config = () => {
  const env = (process.env.PHONEPE_ENV || "UAT").toUpperCase() === "PROD" ? "PROD" : "UAT";
  return {
    env,
    ...HOSTS[env],
    merchantId: process.env.PHONEPE_MERCHANT_ID || "",
    clientId: process.env.PHONEPE_CLIENT_ID || "",
    clientSecret: process.env.PHONEPE_CLIENT_SECRET || "",
    clientVersion: process.env.PHONEPE_CLIENT_VERSION || "1",
  };
};

// v2 needs real merchant credentials in every environment — unlike v1 there is
// no public test merchant, so an unconfigured server must say so rather than
// pretend online payment works.
const isConfigured = () => {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
};

// Access tokens last ~15 minutes; cache and refresh a minute early rather than
// paying an extra round-trip on every checkout.
let tokenCache = { value: null, expiresAt: 0 };

const getAccessToken = async () => {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.value;
  }

  const { oauth, clientId, clientSecret, clientVersion } = config();

  const form = new URLSearchParams({
    client_id: clientId,
    client_version: clientVersion,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  const { data } = await axios.post(oauth, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  if (!data?.access_token) {
    throw new Error("PhonePe OAuth did not return an access_token");
  }

  // expires_at is epoch *seconds*.
  tokenCache = {
    value: data.access_token,
    expiresAt: data.expires_at ? data.expires_at * 1000 : now + 10 * 60_000,
  };
  return tokenCache.value;
};

const authHeaders = async () => ({
  "Content-Type": "application/json",
  Authorization: `O-Bearer ${await getAccessToken()}`,
});

// Creates the order PhonePe's SDK will pay for. Returns the orderId + token the
// app feeds straight into startTransaction.
const createSdkOrder = async ({ merchantOrderId, amountInRupees, userId }) => {
  const { api } = config();

  // PhonePe bills in paise. This is the only rupees→paise conversion, and it
  // never reaches the database.
  const amount = Math.round(Number(amountInRupees) * 100);

  const { data } = await axios.post(
    `${api}/checkout/v2/sdk/order`,
    {
      merchantOrderId,
      amount,
      paymentFlow: { type: "PG_CHECKOUT" },
      metaInfo: { udf1: `user:${userId}` },
    },
    { headers: await authHeaders(), timeout: 20000 }
  );

  if (!data?.orderId || !data?.token) {
    throw new Error(
      `PhonePe order creation failed: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return { orderId: data.orderId, token: data.token, expireAt: data.expireAt };
};

/**
 * Creates a browser checkout and returns the URL to send the customer to.
 *
 * The web storefront cannot use createSdkOrder: that returns a token for the
 * native Android/iOS SDK, which has no browser equivalent. PhonePe's web flow
 * is a full-page redirect to their hosted checkout, which renders the UPI app
 * picker and card form itself, then sends the customer back to redirectUrl.
 *
 * redirectUrl must be publicly reachable — PhonePe redirects the customer's
 * browser there, and it is where we pick the payment back up and verify it.
 */
const createHostedCheckout = async ({ merchantOrderId, amountInRupees, userId, redirectUrl }) => {
  const { api } = config();
  const amount = Math.round(Number(amountInRupees) * 100);

  const { data } = await axios.post(
    `${api}/checkout/v2/pay`,
    {
      merchantOrderId,
      amount,
      // 20 minutes. A checkout left open longer than that is abandoned, and
      // expiring it keeps the reconciliation sweeper's backlog honest.
      expireAfter: 1200,
      metaInfo: { udf1: `user:${userId}` },
      paymentFlow: {
        type: "PG_CHECKOUT",
        message: "Complete your My First Bite order",
        merchantUrls: { redirectUrl },
      },
    },
    { headers: await authHeaders(), timeout: 20000 }
  );

  if (!data?.redirectUrl) {
    throw new Error(
      `PhonePe checkout creation failed: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return {
    orderId: data.orderId,
    redirectUrl: data.redirectUrl,
    expireAt: data.expireAt,
  };
};

// Server-side truth. The SDK's client-side result is only a hint — this decides
// whether an order is created.
const fetchStatus = async (merchantOrderId) => {
  const { api } = config();

  const { data } = await axios.get(
    `${api}/checkout/v2/order/${merchantOrderId}/status?details=false`,
    {
      headers: await authHeaders(),
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  const state = data?.state || "UNKNOWN";
  // paymentDetails carries the per-attempt transaction ids.
  const detail = Array.isArray(data?.paymentDetails) ? data.paymentDetails[0] : null;

  return {
    raw: data,
    success: state === "COMPLETED",
    pending: state === "PENDING",
    state,
    providerTxnId: detail?.transactionId || data?.orderId || null,
    // UPI_INTENT / UPI_COLLECT / CARD / NET_BANKING — what was actually used.
    instrument: detail?.paymentMode || null,
    message: data?.errorCode || data?.detailedErrorCode || state,
    // PhonePe reports paise everywhere; settlement compares rupees.
    amountInRupees: Number.isFinite(Number(data?.amount))
      ? Number(data.amount) / 100
      : null,
  };
};

/**
 * Refunds a completed payment, in full or in part.
 *
 * merchantRefundId is OUR idempotency key: PhonePe treats a repeat of the same
 * id as the same refund rather than a second one, which is the property that
 * makes it safe to retry after a timeout. Generating a fresh id on retry would
 * pay the customer twice, so callers must persist the id BEFORE calling and
 * reuse it — see util/orderLifecycle.js, which claims it with a unique index.
 *
 * The response is asynchronous: PENDING means accepted, not settled. Money
 * typically lands in 3-5 working days for cards, faster for UPI.
 */
const refundPayment = async ({ merchantRefundId, originalMerchantOrderId, amountInRupees }) => {
  const { api } = config();
  const amount = Math.round(Number(amountInRupees) * 100);

  const { data } = await axios.post(
    `${api}/payments/v2/refund`,
    { merchantRefundId, originalMerchantOrderId, amount },
    {
      headers: await authHeaders(),
      timeout: 20000,
      // 4xx carries a structured reason we want to record rather than throw.
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  const state = data?.state || "UNKNOWN";
  const accepted = state === "PENDING" || state === "COMPLETED" || state === "CONFIRMED";

  return {
    raw: data,
    accepted,
    state,
    refundId: data?.refundId || null,
    amount: data?.amount ?? amount,
    message: data?.message || data?.code || data?.errorCode || state,
  };
};

/** Where a refund actually got to. Used by the reconciliation sweep. */
const fetchRefundStatus = async (merchantRefundId) => {
  const { api } = config();

  const { data } = await axios.get(
    `${api}/payments/v2/refund/${merchantRefundId}/status`,
    {
      headers: await authHeaders(),
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  const state = data?.state || "UNKNOWN";
  return {
    raw: data,
    state,
    completed: state === "COMPLETED",
    failed: state === "FAILED",
    message: data?.errorCode || data?.detailedErrorCode || state,
  };
};

// v2 webhooks authenticate with a shared username/password configured in the
// PhonePe dashboard: header Authorization = sha256("username:password").
// Nothing else about the request is signed, so this check is what makes a
// callback trustworthy.
const verifyCallbackAuth = (authHeader) => {
  const user = process.env.PHONEPE_WEBHOOK_USERNAME || "";
  const pass = process.env.PHONEPE_WEBHOOK_PASSWORD || "";
  if (!user || !pass || !authHeader) return false;

  const expected = crypto
    .createHash("sha256")
    .update(`${user}:${pass}`)
    .digest("hex");

  // PhonePe may send it bare or with a SHA256 prefix.
  const received = String(authHeader).replace(/^SHA256=?/i, "").trim().toLowerCase();

  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = {
  config,
  isConfigured,
  createSdkOrder,
  createHostedCheckout,
  fetchStatus,
  refundPayment,
  fetchRefundStatus,
  verifyCallbackAuth,
  // exported for tests
  _resetTokenCache: () => {
    tokenCache = { value: null, expiresAt: 0 };
  },
};
