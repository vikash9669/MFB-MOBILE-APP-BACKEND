const crypto = require("crypto");
const { PaymentIntent } = require("../models");
const phonepe = require("../util/phonepe");
const origins = require("../util/origins");
const { priceCart, findOrderById } = require("../util/orders");
// Order creation from a paid intent lives in one place, shared with the
// webhook and the reconciliation sweeper — see util/paymentSettlement.js.
const { settleIntent } = require("../util/paymentSettlement");
const {
  loadCollectionIntent,
  settleCollection,
  statusFor,
} = require("../util/codCollection");
const dqr = require("../util/phonepeDqr");

const ONLINE_METHODS = ["UPI", "CARD"];


const newMerchantTxnId = (user_id) =>
  // Bounded to PhonePe's 38-char limit for merchantTransactionId.
  `MFB${Date.now()}${user_id}${crypto.randomBytes(3).toString("hex")}`.slice(0, 38);

// POST /user/payment/initiate
// Prices the cart, parks it as a PENDING intent, and returns the signed payload
// the app hands to the PhonePe SDK. No store_orders row exists yet.
const initiatePayment = async (req, res) => {
  const { user_id } = req.user;
  const {
    address_id,
    product_ids_with_quantity,
    business_user_id,
    coupon_code,
    platform,
    method,
  } = req.body;

  if (!ONLINE_METHODS.includes(String(method || "").toUpperCase())) {
    return res
      .status(400)
      .json({ message: `Unsupported payment method: ${method}` });
  }

  if (!phonepe.isConfigured()) {
    return res.status(503).json({
      message:
        "Online payment is not configured. Set PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET (and PHONEPE_MERCHANT_ID) in the backend .env.",
    });
  }

  try {
    const pricing = await priceCart({
      address_id,
      product_ids_with_quantity,
      business_user_id,
      coupon_code,
      platform,
    });

    if (!(pricing.payable > 0)) {
      return res.status(400).json({ message: "Nothing to pay for this cart" });
    }

    const merchantTransactionId = newMerchantTxnId(user_id);

    // The web storefront and the mobile apps need different things from
    // PhonePe: a browser gets a full-page redirect to hosted checkout, an app
    // gets an SDK token. Same intent, same verification, different handoff.
    const isWeb = String(req.body.flow || platform || "").toLowerCase() === "web";

    await PaymentIntent.create({
      merchant_txn_id: merchantTransactionId,
      customer_id: user_id,
      vendor_id: business_user_id,
      address_id,
      amount: pricing.payable,
      // Snapshot the request so the order is rebuilt from what was priced, not
      // from whatever the client sends to /confirm.
      cart_snapshot: JSON.stringify({
        product_ids_with_quantity,
        coupon_code: coupon_code ?? null,
        platform: platform ?? null,
      }),
      method: String(method).toUpperCase(),
      status: "PENDING",
    });

    if (isWeb) {
      // Where PhonePe sends the customer's browser once they are done.
      //
      // Taken from the origin this request came from, checked against the CORS
      // allowlist — the customer is demonstrably already there, so it cannot be
      // stale the way configuration can. STOREFRONT_URL remains the fallback.
      //
      // This used to read configuration first, and an unset STOREFRONT_URL on a
      // deployed host meant "http://localhost:5173": customers who had really
      // paid were redirected to their own machine and saw a dead page.
      //
      // Unlike the webhook, this does NOT need to be publicly reachable — the
      // redirect is performed by the customer's own browser, so localhost is
      // still correct when testing on one machine.
      const base = origins.webBase(req);
      const redirectUrl = `${base}/payment/return?txn=${encodeURIComponent(
        merchantTransactionId
      )}`;

      const hosted = await phonepe.createHostedCheckout({
        merchantOrderId: merchantTransactionId,
        amountInRupees: pricing.payable,
        userId: user_id,
        redirectUrl,
      });

      return res.status(201).json({
        merchant_txn_id: merchantTransactionId,
        amount: pricing.payable,
        // The browser is sent here; there is no token to hand a native SDK.
        redirect_url: hosted.redirectUrl,
        flow: "web",
      });
    }

    const { orderId, token } = await phonepe.createSdkOrder({
      merchantOrderId: merchantTransactionId,
      amountInRupees: pricing.payable,
      userId: user_id,
    });

    const cfg = phonepe.config();

    res.status(201).json({
      merchant_txn_id: merchantTransactionId,
      amount: pricing.payable,
      // Everything below is fed straight into the SDK by the app.
      order_id: orderId,
      token,
      merchant_id: cfg.merchantId,
      // "SANDBOX" | "PRODUCTION" — the value PhonePePaymentSDK.init() wants.
      environment: cfg.sdk,
      flow: "sdk",
    });
  } catch (error) {
    console.error("MFB-error-logs ~ initiatePayment:", error);
    res
      .status(500)
      .json({ message: "Could not start payment", error: error.message });
  }
};

// POST /user/payment/confirm  { merchant_txn_id }
// Called by the app when the SDK returns. The SDK's own result is treated as a
// hint only — PhonePe's status API is the authority.
const confirmPayment = async (req, res) => {
  const { user_id } = req.user;
  const { merchant_txn_id } = req.body;

  try {
    const intent = await PaymentIntent.findOne({
      where: { merchant_txn_id, customer_id: user_id },
    });

    if (intent == null) {
      return res.status(404).json({ message: "Payment not found" });
    }

    if (intent.status === "PAID" && intent.order_id) {
      const order = await findOrderById(intent.order_id);
      return res.status(200).json({ status: "PAID", order });
    }

    const status = await phonepe.fetchStatus(merchant_txn_id);

    if (status.pending) {
      return res
        .status(202)
        .json({ status: "PENDING", message: "Payment is still processing" });
    }

    if (!status.success) {
      await intent.update({
        status: "FAILED",
        failure_reason: `${status.state}: ${status.message}`.slice(0, 255),
      });
      return res
        .status(402)
        .json({ status: "FAILED", message: status.message || "Payment failed" });
    }

    const { order_id } = await settleIntent(intent, status.providerTxnId);
    const order = await findOrderById(order_id);

    res.status(201).json({ status: "PAID", order });
  } catch (error) {
    console.error("MFB-error-logs ~ confirmPayment:", error);
    res
      .status(500)
      .json({ message: "Could not confirm payment", error: error.message });
  }
};

// POST /payment/phonepe/callback
// PhonePe's server-to-server notification. There is no JWT here — trust comes
// from the dashboard-configured Authorization credential (v2 webhook auth).
const phonepeCallback = async (req, res) => {
  try {
    if (!phonepe.verifyCallbackAuth(req.headers.authorization)) {
      console.warn("MFB ~ phonepeCallback: bad or missing authorization");
      return res.status(401).json({ message: "Invalid signature" });
    }

    // v2 body is nominally { event | type, payload: { merchantOrderId, state } },
    // but the id has shown up as merchantTransactionId and at the top level
    // depending on the event, and an unrecognised shape used to throw a
    // Sequelize "invalid undefined value" on every single callback. Accept the
    // known spellings and bail cleanly on anything else.
    const body = req.body || {};
    const payload = body.payload || body.data || {};
    const merchantOrderId =
      payload.merchantOrderId ||
      payload.merchantTransactionId ||
      body.merchantOrderId ||
      body.merchantTransactionId ||
      null;
    const state = payload.state || payload.status || body.state;

    if (!merchantOrderId) {
      console.warn(
        "MFB ~ phonepeCallback: no merchant order id in payload; keys =",
        // Keys only — a webhook body can carry payer details.
        `body:[${Object.keys(body)}] payload:[${Object.keys(payload)}]`
      );
      return res.status(200).json({ ok: true });
    }

    // A doorstep collection settles an order that already exists; a checkout
    // intent creates one. Sending the first down the second path would mint a
    // duplicate order for money collected against the original, so the branch
    // comes before anything else touches the row.
    const collection = await loadCollectionIntent(merchantOrderId);
    if (collection != null) {
      // statusFor picks between the PG and offline-QR status APIs. They keep
      // separate ledgers, so asking the wrong one reports an unknown
      // transaction and the payment stays PENDING for ever.
      const status = await statusFor(collection);
      if (status.success && collection.status !== "PAID") {
        await settleCollection(collection);
      } else if (!status.success && !status.pending && collection.status === "PENDING") {
        await PaymentIntent.update(
          { status: "FAILED", failure_reason: String(state || status.state).slice(0, 255) },
          { where: { pi_id: collection.pi_id } }
        );
      }
      return res.status(200).json({ ok: true });
    }

    const intent = await PaymentIntent.findOne({
      where: { merchant_txn_id: merchantOrderId },
    });

    // Always 200 on an authenticated callback so PhonePe stops retrying.
    if (intent == null) return res.status(200).json({ ok: true });

    // Re-verify against the status API rather than trusting the webhook body,
    // so a replayed or malformed payload cannot mark an order paid.
    const status = await phonepe.fetchStatus(merchantOrderId);

    if (status.success && intent.status !== "PAID") {
      await settleIntent(intent, status.providerTxnId);
    } else if (!status.success && !status.pending && intent.status === "PENDING") {
      await intent.update({
        status: "FAILED",
        failure_reason: String(state || status.state).slice(0, 255),
      });
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("MFB-error-logs ~ phonepeCallback:", error);
    res.status(200).json({ ok: true });
  }
};

// POST /payment/phonepe/qr-callback
//
// The offline Dynamic QR product's server-to-server notification. It is a
// separate endpoint from phonepeCallback because the two products authenticate
// differently: PG v2 sends a dashboard-configured Authorization header, while
// DQR sends X-VERIFY, a SHA256 over the base64 body and the salt key. Trying to
// serve both from one handler would mean accepting either signature on either
// product, which is a downgrade for both.
//
// Body is { response: "<base64 json>" }.
const phonepeQrCallback = async (req, res) => {
  try {
    const bodyBase64 = req.body?.response || req.body?.request;
    if (!dqr.verifyCallback(bodyBase64, req.headers["x-verify"])) {
      console.warn("MFB ~ phonepeQrCallback: bad or missing X-VERIFY");
      return res.status(401).json({ message: "Invalid signature" });
    }

    const decoded = dqr.decodeCallback(bodyBase64);
    const txnId = decoded?.data?.transactionId || decoded?.data?.merchantTransactionId;
    if (!txnId) {
      // Keys only — a callback body carries payer details.
      console.warn(
        "MFB ~ phonepeQrCallback: no transaction id; keys =",
        `[${Object.keys(decoded?.data ?? {})}]`
      );
      return res.status(200).json({ ok: true });
    }

    const collection = await loadCollectionIntent(txnId);
    if (collection == null) return res.status(200).json({ ok: true });

    // Re-verify with the status API rather than trusting the body. The
    // signature proves the message came from PhonePe, not that it is current —
    // a replayed callback must not settle anything on its own say-so.
    const status = await statusFor(collection);
    if (status.success && collection.status !== "PAID") {
      await settleCollection(collection);
    } else if (!status.success && !status.pending && collection.status === "PENDING") {
      await PaymentIntent.update(
        { status: "FAILED", failure_reason: String(status.state).slice(0, 255) },
        { where: { pi_id: collection.pi_id } }
      );
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("MFB-error-logs ~ phonepeQrCallback:", error.message);
    // 200 regardless, so PhonePe stops retrying a message we have accepted.
    res.status(200).json({ ok: true });
  }
};

module.exports = { initiatePayment, confirmPayment, phonepeCallback, phonepeQrCallback };
