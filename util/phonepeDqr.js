const crypto = require("crypto");
const axios = require("axios");

// PhonePe **Dynamic QR** (the offline / in-store product), used to take a COD
// order's payment at the door.
//
// This is a DIFFERENT product from util/phonepe.js, and the difference is the
// whole reason this file exists:
//
//   util/phonepe.js  PG Standard Checkout v2. OAuth (O-Bearer), and every
//                    payment flow — including the ones literally named UPI_QR
//                    and UPI_INTENT — returns only a hosted checkout
//                    `redirectUrl`. Encoding that URL in a QR produces a code
//                    that opens a web page, which is not a payment QR: the
//                    customer lands on a merchant checkout and has to start
//                    again. Verified against the live UAT merchant.
//
//   this file        Offline Dynamic QR. Returns `qrString`, a genuine
//                    `upi://pay?pa=…&am=…` payload. Any UPI app scans it and
//                    goes straight to a confirm-payment screen with the amount
//                    already filled in. This is what a rider's phone should be
//                    showing at a doorstep.
//
// It also authenticates completely differently — X-VERIFY salt-key checksums,
// PhonePe's older scheme — so it needs its own credentials and cannot borrow
// the PG client's OAuth. Docs:
// https://developer.phonepe.com/offline-integration/dynamic-qr-solution/dqr-init-api
//
// Everything here degrades to nothing when unconfigured: isConfigured() is
// false and the caller falls back to the hosted-checkout URL, which is what
// shipped before. Adding the credentials is what switches it on.

const HOSTS = {
  UAT: "https://mercury-uat.phonepe.com/enterprise-sandbox",
  PROD: "https://mercury-t2.phonepe.com",
};

const INIT_PATH = "/v3/qr/init";

const config = () => {
  const env = (process.env.PHONEPE_ENV || "UAT").toUpperCase() === "PROD" ? "PROD" : "UAT";
  return {
    env,
    host: HOSTS[env],
    // The merchant id is shared with the PG product unless overridden — some
    // merchants are onboarded to offline under a different id.
    merchantId: process.env.PHONEPE_DQR_MERCHANT_ID || process.env.PHONEPE_MERCHANT_ID || "",
    saltKey: process.env.PHONEPE_DQR_SALT_KEY || "",
    saltIndex: process.env.PHONEPE_DQR_SALT_INDEX || "1",
    // PhonePe requires a store against which the QR is raised. One logical
    // store for the whole fleet is fine: the rider is the terminal, not the
    // store, and per-order attribution comes from transactionId.
    storeId: process.env.PHONEPE_DQR_STORE_ID || "",
    terminalId: process.env.PHONEPE_DQR_TERMINAL_ID || "",
    callbackUrl: process.env.PHONEPE_DQR_CALLBACK_URL || "",
  };
};

/**
 * Whether a real UPI QR can be issued.
 *
 * storeId is as load-bearing as the salt key — PhonePe rejects an init without
 * it, so a half-filled config must read as "off" rather than fail per order at
 * a doorstep.
 */
const isConfigured = () => {
  const c = config();
  return Boolean(c.merchantId && c.saltKey && c.storeId);
};

/**
 * X-VERIFY for a POST: SHA256(base64Payload + path + saltKey) + "###" + index.
 *
 * The path is part of the digest, so a checksum is not transferable between
 * endpoints — which is why it is passed in rather than hardcoded.
 */
const checksum = (payloadBase64, path, saltKey, saltIndex) =>
  `${crypto.createHash("sha256").update(`${payloadBase64}${path}${saltKey}`).digest("hex")}###${saltIndex}`;

/** X-VERIFY for a GET: same, minus the body. */
const checksumForPath = (path, saltKey, saltIndex) =>
  `${crypto.createHash("sha256").update(`${path}${saltKey}`).digest("hex")}###${saltIndex}`;

/**
 * PhonePe's transactionId charset is narrower than our merchant txn ids.
 *
 * Docs allow alphanumerics plus hyphen and underscore, max 35 characters. Our
 * ids are already alphanumeric, but this is the boundary where a rejected
 * character costs a payment at a doorstep, so it is enforced rather than
 * assumed.
 */
const safeTransactionId = (raw) => String(raw).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 35);

/**
 * Raises a dynamic QR for one payment.
 *
 * Returns { transactionId, qrString, expiresIn }. qrString is a upi:// payload
 * to be rendered as a QR — never a URL.
 *
 * Note PhonePe treats each QR as single-use: once a customer has *started*
 * paying against it, it cannot be scanned again. Retries therefore need a new
 * transactionId, which is why the caller owns id generation.
 */
async function createQr({ merchantTxnId, amountInRupees, expiresInSec = 900, merchantOrderId }) {
  const c = config();
  if (!isConfigured()) {
    throw new Error("PhonePe dynamic QR is not configured");
  }

  const transactionId = safeTransactionId(merchantTxnId);
  const payload = {
    merchantId: c.merchantId,
    transactionId,
    // Paise, like every other PhonePe amount.
    amount: Math.round(Number(amountInRupees) * 100),
    storeId: c.storeId,
    expiresIn: Math.round(expiresInSec),
    ...(c.terminalId ? { terminalId: c.terminalId } : {}),
    ...(merchantOrderId ? { merchantOrderId: String(merchantOrderId) } : {}),
  };

  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

  const headers = {
    "Content-Type": "application/json",
    "X-VERIFY": checksum(body, INIT_PATH, c.saltKey, c.saltIndex),
  };
  // Ask for a server-to-server callback when we have somewhere to receive it.
  // Without a public URL the status poll is the only signal, which still works
  // — it is just slower.
  if (c.callbackUrl) {
    headers["X-CALLBACK-URL"] = c.callbackUrl;
    headers["X-CALL-MODE"] = "POST";
  }

  const { data } = await axios.post(
    `${c.host}${INIT_PATH}`,
    { request: body },
    { headers, timeout: 20000 }
  );

  const qrString = data?.data?.qrString;
  if (!data?.success || !qrString) {
    throw new Error(
      `PhonePe QR init failed: ${JSON.stringify({ code: data?.code, message: data?.message }).slice(0, 200)}`
    );
  }

  return { transactionId, qrString, expiresIn: Math.round(expiresInSec) };
}

/**
 * Asks PhonePe whether a QR has been paid.
 *
 * Shaped to match util/phonepe.js fetchStatus so callers can treat the two
 * interchangeably: { success, pending, state, providerTxnId, message }.
 */
async function fetchQrStatus(merchantTxnId) {
  const c = config();
  if (!isConfigured()) {
    throw new Error("PhonePe dynamic QR is not configured");
  }

  const transactionId = safeTransactionId(merchantTxnId);
  const path = `/v3/transaction/${c.merchantId}/${transactionId}/status`;

  const { data } = await axios.get(`${c.host}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-VERIFY": checksumForPath(path, c.saltKey, c.saltIndex),
      "X-MERCHANT-ID": c.merchantId,
    },
    timeout: 20000,
  });

  const state = data?.data?.state || data?.code || "UNKNOWN";
  return {
    success: data?.success === true && state === "COMPLETED",
    // Anything not yet final. Treated as "keep asking" by every caller, so an
    // unrecognised state must land here rather than being called a failure.
    pending: ["PENDING", "PAYMENT_PENDING", "INITIATED"].includes(String(state).toUpperCase()),
    state,
    providerTxnId: data?.data?.transactionId || data?.data?.providerReferenceId || null,
    message: data?.message || null,
  };
}

/**
 * Verifies a DQR callback really came from PhonePe.
 *
 * The callback body is base64 of the same JSON, and X-VERIFY is computed over
 * it exactly as for a request. Compared with timingSafeEqual because this is
 * the check that decides whether money is treated as received.
 */
function verifyCallback(bodyBase64, xVerifyHeader) {
  const c = config();
  if (!isConfigured() || !bodyBase64 || !xVerifyHeader) return false;

  // Path is absent from callback digests — PhonePe signs body + salt only.
  const expected = `${crypto
    .createHash("sha256")
    .update(`${bodyBase64}${c.saltKey}`)
    .digest("hex")}###${c.saltIndex}`;

  const a = Buffer.from(String(xVerifyHeader));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Decodes a callback body into its JSON, or null if it isn't decodable. */
function decodeCallback(bodyBase64) {
  try {
    return JSON.parse(Buffer.from(String(bodyBase64), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  config,
  isConfigured,
  createQr,
  fetchQrStatus,
  verifyCallback,
  decodeCallback,
  // exported for tests
  _checksum: checksum,
  _checksumForPath: checksumForPath,
  _safeTransactionId: safeTransactionId,
};
