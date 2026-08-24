const crypto = require("crypto");
const { PaymentIntent, User } = require("../models");
// One interface, whichever provider is configured — see util/gateway.js.
const gateway = require("../util/gateway");
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

const ONLINE_METHODS = ["UPI", "CARD"];


// Cashfree requires a customer id and a 10-digit phone on every order;
// PhonePe wants neither. Looked up once here and passed to whichever driver is
// active, which ignores what it does not need. Never allowed to fail a
// checkout — the drivers substitute a placeholder if this comes back empty.
const customerFor = async (user_id) => {
  try {
    const u = await User.findByPk(user_id, {
      attributes: ["user_name", "user_phone", "user_email"],
    });
    return {
      id: user_id,
      phone: u?.user_phone ?? null,
      name: u?.user_name ?? null,
      email: u?.user_email ?? null,
    };
  } catch (err) {
    console.log("MFB ~ payment ~ customer lookup ~", err.message);
    return { id: user_id };
  }
};

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

  if (!gateway.isConfigured()) {
    return res.status(503).json({
      message:
        `Online payment is not configured for provider "${gateway.name}". ` +
        "Set the matching CLIENT_ID / CLIENT_SECRET in the backend .env.",
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

      const hosted = await gateway.createHostedCheckout({
        merchantOrderId: merchantTransactionId,
        amountInRupees: pricing.payable,
        userId: user_id,
        customer: await customerFor(user_id),
        redirectUrl,
        notifyUrl: `${process.env.PUBLIC_API_URL || ""}/payment/callback`,
      });

      return res.status(201).json({
        merchant_txn_id: merchantTransactionId,
        amount: pricing.payable,
        // The two providers hand a browser off differently, and the storefront
        // branches on `provider` rather than guessing: PhonePe issues a URL to
        // navigate to, Cashfree issues a session its JS SDK consumes in place.
        provider: gateway.name,
        redirect_url: hosted.redirectUrl ?? null,
        payment_session_id: hosted.sessionId ?? null,
        environment: gateway.config().sdk,
        flow: "web",
      });
    }

    const { orderId, token, sessionId } = await gateway.createSdkOrder({
      merchantOrderId: merchantTransactionId,
      amountInRupees: pricing.payable,
      userId: user_id,
      customer: await customerFor(user_id),
      notifyUrl: `${process.env.PUBLIC_API_URL || ""}/payment/callback`,
    });

    const cfg = gateway.config();

    res.status(201).json({
      merchant_txn_id: merchantTransactionId,
      amount: pricing.payable,
      // Everything below is fed straight into the SDK by the app. Which fields
      // matter depends on the provider, so all of them are sent and the app
      // picks by `provider`: PhonePe needs order_id + token + merchant_id,
      // Cashfree needs order_id + payment_session_id.
      provider: gateway.name,
      order_id: orderId,
      token,
      payment_session_id: sessionId ?? null,
      merchant_id: cfg.merchantId,
      // "SANDBOX" | "PRODUCTION" — what both SDKs' init/enum expect.
      environment: cfg.sdk,
      flow: "sdk",
    });
  } catch (error) {
    console.error("MFB-error-logs ~ initiatePayment:", error);
    res
      .status(500)
      .json({ message: "Could not start payment" });
  }
};

// POST /user/payment/confirm  { merchant_txn_id }
// Called by the app when the SDK returns. The SDK's own result is treated as a
// hint only — PhonePe's status API is the authority.
const confirmPayment = async (req, res) => {
  const { user_id } = req.user;
  const { merchant_txn_id } = req.body || {};

  // Sequelize throws on an undefined value in a WHERE clause, so a request
  // missing this field came back as a 500 carrying the raw driver message
  // rather than the 400 it plainly is.
  if (!merchant_txn_id) {
    return res.status(400).json({ message: "merchant_txn_id is required" });
  }

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

    const status = await gateway.fetchStatus(merchant_txn_id);

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
      .json({ message: "Could not confirm payment" });
  }
};

// POST /payment/callback  (also /payment/phonepe/callback)
// PhonePe's server-to-server notification. There is no JWT here — trust comes
// from the dashboard-configured Authorization credential (v2 webhook auth).
const paymentCallback = async (req, res) => {
  try {
    if (!gateway.verifyCallbackAuth(req)) {
      console.warn(`MFB ~ paymentCallback (${gateway.name}): bad or missing signature`);
      return res.status(401).json({ message: "Invalid signature" });
    }

    // Body shapes differ per provider and have drifted between versions, so
    // each driver pulls out our order id and the reported state itself. A shape
    // nobody recognises returns null rather than throwing — an unparseable
    // callback used to blow up on every single delivery.
    const parsed = gateway.parseCallback(req);
    const merchantOrderId = parsed?.merchantOrderId ?? null;
    const state = parsed?.state ?? null;

    if (!merchantOrderId) {
      // Keys only — a webhook body can carry payer details.
      console.warn(
        `MFB ~ paymentCallback (${gateway.name}): no order id in payload; keys =`,
        `[${Object.keys(req.body || {})}]`
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
    const status = await gateway.fetchStatus(merchantOrderId);

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
    console.error("MFB-error-logs ~ paymentCallback:", error);
    res.status(200).json({ ok: true });
  }
};

// POST /payment/qr-callback  (also /payment/phonepe/qr-callback)
//
// The offline Dynamic QR product's server-to-server notification. It is a
// separate endpoint from phonepeCallback because the two products authenticate
// differently: PG v2 sends a dashboard-configured Authorization header, while
// DQR sends X-VERIFY, a SHA256 over the base64 body and the salt key. Trying to
// serve both from one handler would mean accepting either signature on either
// product, which is a downgrade for both.
//
// Body is { response: "<base64 json>" }.
const qrCallback = async (req, res) => {
  try {
    if (!gateway.verifyQrCallback(req)) {
      console.warn(`MFB ~ qrCallback (${gateway.name}): bad or missing signature`);
      return res.status(401).json({ message: "Invalid signature" });
    }

    const txnId = gateway.parseQrCallback(req)?.merchantOrderId ?? null;
    if (!txnId) {
      // Keys only — a callback body carries payer details.
      console.warn(
        `MFB ~ qrCallback (${gateway.name}): no transaction id; keys =`,
        `[${Object.keys(req.body || {})}]`
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
    console.error("MFB-error-logs ~ qrCallback:", error.message);
    // 200 regardless, so PhonePe stops retrying a message we have accepted.
    res.status(200).json({ ok: true });
  }
};

module.exports = { initiatePayment, confirmPayment, paymentCallback, qrCallback };
