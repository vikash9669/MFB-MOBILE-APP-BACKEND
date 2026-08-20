// Taking payment online for a COD order, at the customer's door.
//
// The rider offers "pay online instead", the app shows a QR for the exact
// amount, the customer scans and pays, and the order flips from cash to paid.
//
// THREE RULES SHAPE THIS FILE, and all three are about money rather than UX:
//
//  1. THE RIDER CANNOT DECLARE THE PAYMENT DONE. Nothing here trusts the app.
//     Only PhonePe's status API — reached from the poll, the webhook, or the
//     reconciliation sweeper — can mark an order paid. A "mark as paid" button
//     is a rider marking it paid, keeping the cash, and the loss surfacing days
//     later during float reconciliation.
//
//  2. ONE INTENT PER JOB. Re-opening the screen must reuse the live intent, not
//     mint a second payment for one order. Enforced by looking for an unexpired
//     PENDING collection intent before creating anything.
//
//  3. CASH IN HAND MUST NOT MOVE. When the money arrives by UPI the rider is
//     carrying nothing extra, so their float is untouched and cash_to_collect
//     drops to zero. Crediting it would quietly break every rider's reconciliation.
//
// Settlement is idempotent and safe to call from all three paths at once — the
// order flip is a single conditional UPDATE, and the loser is a no-op.
const { QueryTypes } = require("sequelize");
const sequelize = require("./database");
const crypto = require("node:crypto");
const { PaymentIntent, DeliveryOrder, StoreOrders } = require("../models");
const phonepe = require("./phonepe");
const dqr = require("./phonepeDqr");
const origins = require("./origins");
const { collectionReady } = require("./collectionColumns");
const { notifyUser } = require("./customerNotify");
const { notifyPartner } = require("./deliveryNotify");

const PURPOSE = "cod_collection";

// PhonePe expires its own checkout; keep ours a little shorter so a rider is
// never staring at a QR the gateway has already abandoned.
const TTL_SEC = Number(process.env.COD_COLLECT_TTL_SEC) || 900;

const newTxnId = (doId) =>
  `MFBC${Date.now()}${doId}${crypto.randomBytes(2).toString("hex")}`.slice(0, 38);

const rupees = (n) => Math.round(Number(n || 0) * 100) / 100;

// Character-walk rather than a regex: /\/+$/ backtracks badly on a long
// pathological string, and this runs on a request path.

/** The amount still owed in cash on this job. */
const outstanding = (job) => rupees(job.cash_to_collect);

/**
 * The live collection intent for a job, if one is still usable.
 *
 * "Usable" means PENDING and unexpired. A PAID one is returned too, so callers
 * can tell the rider the money already arrived rather than offering a new QR.
 */
async function findLiveIntent(doId) {
  const rows = await sequelize.query(
    `SELECT \`pi_id\`, \`merchant_txn_id\`, \`amount\`, \`status\`, \`collect_url\`, \`expires_at\`
       FROM \`store_payment_intents\`
      WHERE \`do_id\` = :doId AND \`purpose\` = :purpose
        AND (\`status\` = 'PAID'
             OR (\`status\` = 'PENDING' AND \`expires_at\` > UTC_TIMESTAMP()))
      ORDER BY \`pi_id\` DESC
      LIMIT 1`,
    { replacements: { doId, purpose: PURPOSE }, type: QueryTypes.SELECT }
  );
  return rows[0] ?? null;
}

/**
 * Starts (or resumes) a doorstep collection for a delivery job.
 *
 * Returns what the rider's screen needs: the URL to render as a QR, the amount,
 * and when it dies.
 */
async function startCollection({ doId, dpId }) {
  if (!(await collectionReady())) {
    return { ok: false, reason: "not_migrated" };
  }
  if (!phonepe.isConfigured()) {
    return { ok: false, reason: "Online payment is not configured" };
  }

  const job = await DeliveryOrder.findByPk(doId);
  if (job == null) return { ok: false, reason: "Order not found" };
  if (job.dp_id !== dpId) return { ok: false, reason: "Not your order" };
  if (!["accepted", "picked_up"].includes(job.status)) {
    return { ok: false, reason: "This order is not out for delivery" };
  }
  if (String(job.payment_type).toUpperCase() !== "COD") {
    return { ok: false, reason: "This order is already paid online" };
  }

  const amount = outstanding(job);
  if (amount <= 0) {
    return { ok: false, reason: "Nothing left to collect on this order" };
  }

  // Rule 2: reuse before creating.
  const live = await findLiveIntent(doId);
  if (live?.status === "PAID") {
    return { ok: true, alreadyPaid: true, amount: rupees(live.amount) };
  }
  if (live?.collect_url) {
    return {
      ok: true,
      reused: true,
      merchantTxnId: live.merchant_txn_id,
      amount: rupees(live.amount),
      collectUrl: live.collect_url,
      // Read back off the payload rather than stored separately: the string
      // itself is the authority on what kind of code it is, and one fewer
      // column is one fewer way for the two to disagree.
      isUpiQr: isUpiPayload(live.collect_url),
      expiresAt: live.expires_at,
    };
  }

  const merchantTxnId = newTxnId(doId);

  // Prefer a real UPI QR. PhonePe's offline Dynamic QR product returns a
  // `upi://pay?pa=…&am=…` string, so the customer's camera takes them straight
  // to a confirm screen with the amount already filled in. The PG product
  // cannot do this: every one of its flows — including the ones named UPI_QR
  // and UPI_INTENT — returns a hosted checkout URL, and a QR of a URL just
  // opens a web page. See util/phonepeDqr.js.
  //
  // Falls back to that hosted URL when DQR credentials are absent, which keeps
  // doorstep collection working (if clumsily) on a merchant that only has the
  // online product.
  let payload;
  let isUpiQr = false;
  if (dqr.isConfigured()) {
    try {
      const qr = await dqr.createQr({
        merchantTxnId,
        amountInRupees: amount,
        expiresInSec: TTL_SEC,
        merchantOrderId: job.source_order_id ?? undefined,
      });
      payload = qr.qrString;
      isUpiQr = true;
    } catch (err) {
      // A doorstep is the wrong place to fail outright, so drop to the hosted
      // checkout rather than leaving the rider with nothing to show.
      console.log("MFB ~ collection ~ dynamic QR unavailable, using hosted checkout ~", err.message);
    }
  }

  if (payload == null) {
    const hosted = await phonepe.createHostedCheckout({
      merchantOrderId: merchantTxnId,
      amountInRupees: amount,
      userId: job.dp_id,
      // Where PhonePe sends the CUSTOMER'S browser after paying. They are on
      // their own phone, not the rider's, so this points at the storefront's
      // return page rather than anything in the delivery app.
      // No browser request here to read an Origin from, so this one is
      // configuration-only — but it falls back to the CORS allowlist rather
      // than a bare localhost literal.
      redirectUrl: `${origins.webBase(null)}/payment/return?txn=${encodeURIComponent(merchantTxnId)}`,
    });
    payload = hosted.redirectUrl;
  }

  const order = await StoreOrders.findByPk(job.source_order_id, { raw: true });

  await PaymentIntent.create({
    merchant_txn_id: merchantTxnId,
    customer_id: order?.customer_id ?? null,
    vendor_id: order?.vendor_id ?? null,
    address_id: order?.address_id ?? null,
    amount,
    cart_snapshot: JSON.stringify({ doorstep: true, do_id: doId }),
    method: "UPI",
    status: "PENDING",
    // The order already exists — this intent settles an existing order rather
    // than creating one, which is what separates it from a checkout intent.
    order_id: job.source_order_id ?? null,
  });

  await sequelize.query(
    `UPDATE \`store_payment_intents\`
        SET \`purpose\` = :purpose, \`do_id\` = :doId, \`collected_by_dp_id\` = :dpId,
            \`collect_url\` = :url,
            \`expires_at\` = DATE_ADD(UTC_TIMESTAMP(), INTERVAL :ttl SECOND)
      WHERE \`merchant_txn_id\` = :txn`,
    {
      replacements: {
        purpose: PURPOSE,
        doId,
        dpId,
        url: payload,
        ttl: TTL_SEC,
        txn: merchantTxnId,
      },
      type: QueryTypes.UPDATE,
    }
  );

  return {
    ok: true,
    merchantTxnId,
    amount,
    collectUrl: payload,
    // Lets the rider's screen say "scan to pay" rather than "open this link",
    // and is the difference between a one-tap payment and a browser detour.
    isUpiQr,
    expiresAt: new Date(Date.now() + TTL_SEC * 1000),
  };
}

/**
 * Flips a COD order to paid-online. Idempotent.
 *
 * Called from the rider's poll, the PhonePe webhook and the reconciliation
 * sweeper — whichever notices first wins, and the rest are no-ops.
 */
async function settleCollection(intent) {
  const doId = intent.do_id;
  const job = await DeliveryOrder.findByPk(doId);
  if (job == null) return { ok: false, reason: "delivery job vanished" };

  // The claim. Only a still-PENDING intent may settle, so two callers arriving
  // together produce exactly one settlement.
  const [, claimed] = await sequelize.query(
    `UPDATE \`store_payment_intents\` SET \`status\` = 'PAID'
      WHERE \`pi_id\` = :piId AND \`status\` = 'PENDING'`,
    { replacements: { piId: intent.pi_id }, type: QueryTypes.UPDATE }
  );
  if (Number(claimed ?? 0) === 0) {
    return { ok: true, alreadySettled: true };
  }

  // Rule 3: the money came by UPI, so the rider is carrying nothing extra.
  await job.update({ cash_to_collect: 0, cash_collected: false, payment_type: "PG" });

  if (job.source_order_id) {
    await StoreOrders.update(
      {
        order_payment_type: "PG",
        order_payment_status: 1,
        order_payment_received: 1,
        order_amount_paid: rupees(intent.amount),
      },
      { where: { order_id: job.source_order_id } }
    );
  }

  // Tell everyone who is waiting on it.
  notifyPartner(job.dp_id, {
    category: "orders",
    icon: "payments",
    title: "Payment received ✅",
    body: `₹${rupees(intent.amount)} paid online for #${job.order_ref}. No cash to collect.`,
    data: { type: "cod_collected", do_id: String(doId) },
  }).catch(() => {});

  if (intent.customer_id) {
    notifyUser(intent.customer_id, {
      category: "orders",
      icon: "check_circle",
      title: "Payment received",
      body: `We've received ₹${rupees(intent.amount)} for order #${job.order_ref}. Nothing to pay in cash.`,
      refOrderId: job.source_order_id ?? undefined,
    }).catch(() => {});
  }

  console.log(
    `MFB ~ doorstep collection ~ #${job.order_ref} paid online ₹${rupees(intent.amount)} (rider ${job.dp_id})`
  );

  return { ok: true, amount: rupees(intent.amount) };
}

/**
 * Asks PhonePe where a collection stands, settling it if it has completed.
 *
 * This is what the rider's screen polls. The app never decides — it only
 * reports what this returns.
 */
/** A payment payload is a UPI QR if it is a upi:// deep link; anything else is a URL. */
const isUpiPayload = (s) => /^upi:\/\//i.test(String(s || ""));

/**
 * Asks the right PhonePe product whether an intent has been paid.
 *
 * The two products keep separate ledgers: a transaction raised through offline
 * Dynamic QR is invisible to the PG status API and vice versa, so asking the
 * wrong one returns "not found" and the money looks unpaid for ever. The
 * payload records which was used, so it decides.
 */
async function statusFor(intent) {
  if (isUpiPayload(intent.collect_url) && dqr.isConfigured()) {
    return dqr.fetchQrStatus(intent.merchant_txn_id);
  }
  return phonepe.fetchStatus(intent.merchant_txn_id);
}

// dpId is accepted so callers can pass the whole job object, but the lookup
// is by doId alone — the partner is already implied by the collection row.
async function checkCollection({ doId }) {
  if (!(await collectionReady())) return { state: "unavailable" };

  const rows = await sequelize.query(
    `SELECT \`pi_id\`, \`merchant_txn_id\`, \`amount\`, \`status\`, \`customer_id\`, \`do_id\`,
            \`collect_url\`, \`expires_at\`
       FROM \`store_payment_intents\`
      WHERE \`do_id\` = :doId AND \`purpose\` = :purpose
      ORDER BY \`pi_id\` DESC LIMIT 1`,
    { replacements: { doId, purpose: PURPOSE }, type: QueryTypes.SELECT }
  );
  const intent = rows[0];
  if (intent == null) return { state: "none" };

  if (intent.status === "PAID") {
    return { state: "paid", amount: rupees(intent.amount) };
  }
  if (intent.status === "FAILED") {
    return { state: "failed", amount: rupees(intent.amount) };
  }

  const status = await statusFor(intent);
  if (status.success) {
    await settleCollection(intent);
    return { state: "paid", amount: rupees(intent.amount) };
  }
  if (!status.pending) {
    await sequelize.query(
      `UPDATE \`store_payment_intents\`
          SET \`status\` = 'FAILED', \`failure_reason\` = :why
        WHERE \`pi_id\` = :piId AND \`status\` = 'PENDING'`,
      {
        replacements: { piId: intent.pi_id, why: String(status.message).slice(0, 255) },
        type: QueryTypes.UPDATE,
      }
    );
    return { state: "failed", amount: rupees(intent.amount), reason: status.message };
  }

  return {
    state: "pending",
    amount: rupees(intent.amount),
    collectUrl: intent.collect_url,
    expiresAt: intent.expires_at,
  };
}

/** Whether an intent row is a doorstep collection rather than a checkout. */
const isCollection = (intent) => intent?.purpose === PURPOSE;

/**
 * Loads a collection intent by its merchant transaction id, or null.
 *
 * Read raw because `purpose` is deliberately not on the PaymentIntent model:
 * adding it would make every existing SELECT name a column that does not exist
 * before the migration, which is how an optional feature breaks checkout.
 *
 * Used by the webhook and the reconciliation sweeper to decide WHICH settler to
 * run. Getting that branch wrong would send a doorstep payment down the
 * checkout path, which creates a brand new order for money that was collected
 * against an existing one.
 */
async function loadCollectionIntent(merchantTxnId) {
  if (!(await collectionReady())) return null;
  const rows = await sequelize.query(
    `SELECT \`pi_id\`, \`merchant_txn_id\`, \`amount\`, \`status\`, \`customer_id\`,
            \`do_id\`, \`purpose\`, \`order_id\`
       FROM \`store_payment_intents\`
      WHERE \`merchant_txn_id\` = :txn AND \`purpose\` = :purpose
      LIMIT 1`,
    { replacements: { txn: merchantTxnId, purpose: PURPOSE }, type: QueryTypes.SELECT }
  );
  return rows[0] ?? null;
}

/**
 * Collection intents still PENDING that the sweeper should re-check.
 *
 * A customer can pay and immediately lose signal, or the rider can close the
 * screen mid-payment — without this the money sits at PhonePe and the order
 * stays marked cash.
 */
async function pendingCollections(limit = 20) {
  if (!(await collectionReady())) return [];
  return sequelize.query(
    // collect_url comes along because statusFor needs it to pick which PhonePe
    // product to ask.
    `SELECT \`pi_id\`, \`merchant_txn_id\`, \`amount\`, \`status\`, \`customer_id\`, \`do_id\`,
            \`collect_url\`
       FROM \`store_payment_intents\`
      WHERE \`purpose\` = :purpose AND \`status\` = 'PENDING'
        AND \`createdAt\` >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)
      ORDER BY \`pi_id\` ASC
      LIMIT :limit`,
    { replacements: { purpose: PURPOSE, limit }, type: QueryTypes.SELECT }
  );
}

module.exports = {
  startCollection,
  checkCollection,
  settleCollection,
  findLiveIntent,
  loadCollectionIntent,
  pendingCollections,
  isCollection,
  statusFor,
  isUpiPayload,
  PURPOSE,
};
