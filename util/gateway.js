// Which payment provider this deployment uses, behind one interface.
//
// Everything that takes money — controllers/payment.js, util/codCollection.js,
// util/paymentSweeper.js, util/orderLifecycle.js — talks to this module and
// never to a provider directly. Adding a third provider is one new driver plus
// one line in DRIVERS; it is not a change to any caller.
//
// PhonePe is presented through an adapter rather than being rewritten. Its two
// files are the ones that have actually taken money and carry the bug fixes
// that came with doing so, so they are left exactly as they are and the shape
// differences are absorbed here:
//
//   * PhonePe splits ordinary checkout (util/phonepe.js, OAuth) from doorstep
//     QR (util/phonepeDqr.js, X-VERIFY salt checksums) across two products with
//     two credential sets. Cashfree does both from one account.
//   * PhonePe's refund status needs only the refund id; Cashfree scopes refunds
//     under the order and needs both. The interface passes an object, so the
//     caller supplies both and each driver takes what it needs.
//   * Webhook authenticity is a header credential (PhonePe PG), a base64 body
//     checksum (PhonePe DQR), or an HMAC over the raw bytes (Cashfree). Each
//     driver is handed the whole request and decides for itself.
//
// PAYMENT_PROVIDER selects. Unset means phonepe, so an existing deployment that
// has never heard of this variable keeps the behaviour it already had.
const phonepe = require("./phonepe");
const dqr = require("./phonepeDqr");
const cashfree = require("./cashfree");

/** The PhonePe pair, wearing the shared interface. */
const phonepeDriver = {
  name: "phonepe",
  isConfigured: () => phonepe.isConfigured(),
  config: () => {
    const c = phonepe.config();
    return { env: c.env, sdk: c.sdk, merchantId: c.merchantId };
  },

  createSdkOrder: async (args) => {
    const r = await phonepe.createSdkOrder(args);
    // No session id in this protocol; the SDK takes a per-order token.
    return { orderId: r.orderId, token: r.token, sessionId: null, expireAt: r.expireAt };
  },

  createHostedCheckout: async (args) => {
    const r = await phonepe.createHostedCheckout(args);
    return { orderId: r.orderId, redirectUrl: r.redirectUrl, sessionId: null, expireAt: r.expireAt };
  },

  qrConfigured: () => dqr.isConfigured(),
  createUpiQr: async ({ merchantOrderId, amountInRupees, expiresInSec, sourceOrderId }) => {
    if (!dqr.isConfigured()) return null;
    const qr = await dqr.createQr({
      merchantTxnId: merchantOrderId,
      amountInRupees,
      ...(expiresInSec ? { expiresInSec } : {}),
      // DQR carries our store order id as its own reference field, which is
      // separate from the transaction id.
      merchantOrderId: sourceOrderId,
    });
    return qr?.qrString
      ? { qrString: qr.qrString, qrImageBase64: null, providerRef: null, channel: "dqr" }
      : null;
  },

  fetchStatus: (merchantOrderId) => phonepe.fetchStatus(merchantOrderId),
  qrFetchStatus: (merchantOrderId) => dqr.fetchQrStatus(merchantOrderId),

  refundPayment: (args) => phonepe.refundPayment(args),
  fetchRefundStatus: ({ merchantRefundId }) => phonepe.fetchRefundStatus(merchantRefundId),

  verifyCallbackAuth: (req) => phonepe.verifyCallbackAuth(req?.headers?.authorization),

  // v2 nominally sends { payload: { merchantOrderId, state } }, but the id has
  // turned up as merchantTransactionId and at the top level depending on the
  // event, and an unrecognised shape used to throw on every callback. Accept
  // the known spellings and return null for anything else.
  parseCallback: (req) => {
    const body = req?.body || {};
    const payload = body.payload || body.data || {};
    const merchantOrderId =
      payload.merchantOrderId ||
      payload.merchantTransactionId ||
      body.merchantOrderId ||
      body.merchantTransactionId ||
      null;
    const state = payload.state || payload.status || body.state || null;
    return merchantOrderId ? { merchantOrderId, state } : null;
  },

  // The offline QR product signs differently, so it keeps its own pair.
  verifyQrCallback: (req) =>
    dqr.verifyCallback(req?.body?.response || req?.body?.request, req?.headers?.["x-verify"]),
  parseQrCallback: (req) => {
    const decoded = dqr.decodeCallback(req?.body?.response || req?.body?.request);
    const id = decoded?.data?.transactionId || decoded?.data?.merchantTransactionId || null;
    return id ? { merchantOrderId: id, state: decoded?.data?.state ?? null } : null;
  },
};

/** Cashfree already speaks the interface; only the QR gate is added here. */
const cashfreeDriver = {
  name: "cashfree",
  isConfigured: () => cashfree.isConfigured(),
  config: () => {
    const c = cashfree.config();
    return { env: c.env, sdk: c.sdk, merchantId: c.clientId };
  },

  createSdkOrder: (args) => cashfree.createSdkOrder(args),
  createHostedCheckout: (args) => cashfree.createHostedCheckout(args),

  // One account, one credential set — but /orders/sessions is gated behind the
  // S2S flag, which is granted separately. CASHFREE_S2S_ENABLED=true is the
  // switch to flip once Cashfree confirms it, and until then the doorstep flow
  // falls back to a checkout link exactly as it does on PhonePe today.
  qrConfigured: () =>
    cashfree.isConfigured() &&
    String(process.env.CASHFREE_S2S_ENABLED || "").toLowerCase() === "true",
  createUpiQr: async (args) => {
    if (!cashfreeDriver.qrConfigured()) return null;
    return cashfree.createUpiQr(args);
  },

  fetchStatus: (id) => cashfree.fetchStatus(id),
  // No separate offline ledger — the same order status answers both.
  qrFetchStatus: (id) => cashfree.fetchStatus(id),

  refundPayment: (args) => cashfree.refundPayment(args),
  fetchRefundStatus: (args) => cashfree.fetchRefundStatus(args),

  verifyCallbackAuth: (req) => cashfree.verifyCallbackAuth(req),
  parseCallback: (req) => cashfree.parseCallback(req),

  // Cashfree sends QR settlements through the ordinary payment webhook, so the
  // dedicated QR pair points at the same implementation rather than pretending
  // a second channel exists.
  verifyQrCallback: (req) => cashfree.verifyCallbackAuth(req),
  parseQrCallback: (req) => cashfree.parseCallback(req),
};

const DRIVERS = { phonepe: phonepeDriver, cashfree: cashfreeDriver };

const selected = () =>
  String(process.env.PAYMENT_PROVIDER || "phonepe").trim().toLowerCase();

/** The active driver. Read per call so tests can switch provider in-process. */
function driver() {
  return DRIVERS[selected()] || phonepeDriver;
}

// Re-exported as plain functions so callers read `gateway.fetchStatus(id)`
// rather than `gateway.driver().fetchStatus(id)`.
const proxy = {};
for (const method of [
  "isConfigured",
  "config",
  "createSdkOrder",
  "createHostedCheckout",
  "qrConfigured",
  "createUpiQr",
  "fetchStatus",
  "qrFetchStatus",
  "refundPayment",
  "fetchRefundStatus",
  "verifyCallbackAuth",
  "parseCallback",
  "verifyQrCallback",
  "parseQrCallback",
]) {
  proxy[method] = (...args) => driver()[method](...args);
}

// PhonePe says COMPLETED, Cashfree says SUCCESS, and both mean the money has
// actually left. Callers should ask this rather than string-matching, or a
// provider switch silently stops stamping refunded_at.
const isRefundSettled = (state) =>
  ["COMPLETED", "SUCCESS"].includes(String(state || "").toUpperCase());

module.exports = {
  ...proxy,
  isRefundSettled,
  /** Which provider is active, for logs and for the startup report. */
  get name() {
    return driver().name;
  },
  driver,
  DRIVERS,
};
