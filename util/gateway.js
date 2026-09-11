// Which payment provider this deployment uses, behind one interface.
//
// Everything that takes money — controllers/payment.js, util/codCollection.js,
// util/paymentSweeper.js, util/orderLifecycle.js — talks to this module and
// never to a provider directly. Adding a third provider is one new driver plus
// one line in DRIVERS; it is not a change to any caller.
//
// This used to carry a second driver. PhonePe — ordinary checkout plus its
// separate doorstep-QR product — has been removed from the backend and from all
// three frontends, so Cashfree is the only gateway. The indirection is kept:
// it is what made removing a provider a change to this file alone rather than
// to controllers/payment.js, util/codCollection.js, util/paymentSweeper.js and
// util/orderLifecycle.js, and it is what would make adding one cheap again.
//
// PAYMENT_PROVIDER still selects, and now DEFAULTS TO CASHFREE. It used to
// default to phonepe, which meant an unset variable silently chose a gateway
// nothing could drive. Anything other than "cashfree" now resolves to Cashfree
// anyway rather than to a missing driver.
//
// The boot banner is the authority on what a given process actually resolved —
// util/startupReport.js prints `payments <provider> <env>` from this module.
const cashfree = require("./cashfree");

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
  // falls back to a checkout link, which still collects the money.
  qrConfigured: () =>
    cashfree.isConfigured() &&
    String(process.env.CASHFREE_S2S_ENABLED || "").toLowerCase() === "true",
  createUpiQr: async (args) => {
    if (!cashfreeDriver.qrConfigured()) return null;
    return cashfree.createUpiQr(args);
  },

  fetchStatus: (id, opts) => cashfree.fetchStatus(id, opts),
  // No separate offline ledger — the same order status answers both.
  qrFetchStatus: (id, opts) => cashfree.fetchStatus(id, opts),

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

const DRIVERS = { cashfree: cashfreeDriver };

const selected = () =>
  String(process.env.PAYMENT_PROVIDER || "cashfree").trim().toLowerCase();

/** The active driver. Read per call so tests can switch provider in-process. */
function driver() {
  return DRIVERS[selected()] || cashfreeDriver;
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

// Cashfree says SUCCESS. COMPLETED is kept because store_orders.refund_status
// still holds it on rows refunded while PhonePe was the gateway, and because a
// value that no live path returns costs nothing while removing one could stop
// refunded_at being stamped. Callers should ask this rather than
// string-matching a provider's vocabulary.
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
