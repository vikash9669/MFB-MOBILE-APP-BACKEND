// Turning a verified-paid gateway intent into a real order.
//
// Three separate things can discover that a payment succeeded, in any order:
//
//   1. the app's own /user/payment/confirm call
//   2. the gateway's server-to-server webhook
//   3. the reconciliation sweeper (util/paymentSweeper.js)
//
// All three funnel through here so there is exactly one code path that creates
// an order from a payment, and exactly one place where the "only once" rule is
// enforced. The customer must end up with one order no matter how many of the
// three fire, or in what order they fire.
const { PaymentIntent } = require("../models");
const {
  priceCart,
  createOrder,
  runPostOrderSideEffects,
  PAYMENT_COLUMNS,
} = require("./orders");

// Intents already reported as a mismatch, so a sweeper that retries every
// minute raises the alarm once rather than sixty times an hour.
const mismatchAlerted = new Set();

/** Rupee comparison that tolerates float noise but nothing a human would notice. */
const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

/**
 * Settles a paid intent, creating the order.
 *
 * The claim is an atomic conditional UPDATE rather than a read-then-write:
 * `WHERE status = 'PENDING'` means the database itself picks a single winner
 * when the confirm call, the webhook and the sweeper arrive together. A
 * read-then-write leaves a window where all three see PENDING and all three
 * create an order — the customer is charged once and gets three.
 *
 * Returns { order_id, alreadySettled }.
 */
async function settleIntent(intent, providerTxnId, collectedAmount = null) {
  // Does the gateway hold what we asked for?
  //
  // It should be impossible for this to differ: we set the amount when we
  // create the order at the gateway and the customer cannot alter it. So a
  // mismatch means a bug here or an anomaly there, and either way it is not
  // something to resolve by handing over food. Checked BEFORE the claim so a
  // refusal leaves the row exactly as it was.
  //
  // A driver that cannot report an amount passes null, which skips the check
  // rather than blocking a payment that is probably fine.
  if (collectedAmount != null && !sameMoney(collectedAmount, intent.amount)) {
    const short = Number(collectedAmount) < Number(intent.amount);

    if (!mismatchAlerted.has(intent.pi_id)) {
      mismatchAlerted.add(intent.pi_id);
      const { notifyAdminsPaymentMismatch } = require("./adminNotify");
      notifyAdminsPaymentMismatch({
        merchantTxnId: intent.merchant_txn_id,
        quoted: intent.amount,
        collected: collectedAmount,
        settled: !short,
      }).catch((e) => console.log("MFB ~ settle ~ mismatch alert ~", e.message));
    }

    if (short) {
      // Underpaid. Leave the intent PENDING for a human — marking it FAILED
      // would say no money moved, which is untrue and would stop anyone
      // refunding it.
      console.log(
        `MFB ~ settle ~ REFUSING ${intent.merchant_txn_id}: quoted ${intent.amount}, ` +
          `gateway holds ${collectedAmount}`
      );
      return { order_id: null, alreadySettled: false, mismatch: true };
    }
    // Overpaid: the customer is not at fault and has covered the order, so it
    // goes through. The alert above is what gets the difference refunded.
    console.log(
      `MFB ~ settle ~ ${intent.merchant_txn_id} overpaid: quoted ${intent.amount}, ` +
        `gateway holds ${collectedAmount} — settling anyway`
    );
  }

  // Claim it. Exactly one caller can flip PENDING -> PAID.
  const [claimed] = await PaymentIntent.update(
    { status: "PAID", provider_txn_id: providerTxnId ?? null },
    { where: { pi_id: intent.pi_id, status: "PENDING" } }
  );

  if (claimed === 0) {
    // Someone else won the race, or it was already settled. Either way this
    // caller must not create a second order.
    const fresh = await PaymentIntent.findByPk(intent.pi_id);
    return { order_id: fresh?.order_id ?? null, alreadySettled: true };
  }

  const fresh = await PaymentIntent.findByPk(intent.pi_id);

  try {
    const snapshot = JSON.parse(fresh.cart_snapshot);

    // The price the customer agreed to, frozen at initiate.
    //
    // This used to re-run priceCart here. That reads the menu, the coupon table
    // and the delivery area AS THEY ARE NOW — so a vendor editing a price, or a
    // coupon expiring, while the customer was away paying produced an order
    // whose order_amount disagreed with both the quote and the money actually
    // collected. The vendor then saw a total that was never charged.
    //
    // Intents created before this change carry no quote, so those still
    // re-price rather than failing outright.
    let pricing = snapshot.quoted;
    if (pricing == null) {
      console.log(
        `MFB ~ settle ~ intent ${fresh.pi_id} predates the price lock — re-pricing`
      );
      pricing = await priceCart({
        address_id: fresh.address_id,
        product_ids_with_quantity: snapshot.product_ids_with_quantity,
        business_user_id: fresh.vendor_id,
        coupon_code: snapshot.coupon_code,
        platform: snapshot.platform,
        user_id: fresh.customer_id,
      });
    }

    const newOrder = await createOrder({
      user_id: fresh.customer_id,
      business_user_id: fresh.vendor_id,
      address_id: fresh.address_id,
      product_ids_with_quantity: snapshot.product_ids_with_quantity,
      pricing,
      payment: PAYMENT_COLUMNS.paid({
        providerTxnId: providerTxnId || fresh.merchant_txn_id,
        // Charge what was quoted at initiate time, so a price change mid-payment
        // can never bill the customer more than the gateway collected.
        amountInRupees: fresh.amount,
      }),
    });

    await fresh.update({ order_id: newOrder.order_id });

    await runPostOrderSideEffects({
      user_id: fresh.customer_id,
      order_id: newOrder.order_id,
      total_amount: fresh.amount,
    });

    return { order_id: newOrder.order_id, alreadySettled: false };
  } catch (err) {
    // We hold the claim but failed to build the order — a bad cart snapshot, a
    // restaurant that stopped delivering to the address, a database blip. Give
    // the claim back so the next sweep retries instead of leaving a customer
    // who has paid with an intent nothing will ever look at again.
    //
    // Guarded on order_id IS NULL so this can never undo a settlement that did
    // in fact create an order.
    await PaymentIntent.update(
      { status: "PENDING", provider_txn_id: null },
      { where: { pi_id: fresh.pi_id, order_id: null } }
    );
    throw err;
  }
}

module.exports = { settleIntent };
