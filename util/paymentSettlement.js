// Turning a verified-paid PhonePe intent into a real order.
//
// Three separate things can discover that a payment succeeded, in any order:
//
//   1. the app's own /user/payment/confirm call
//   2. PhonePe's server-to-server webhook
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
async function settleIntent(intent, providerTxnId) {
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

    const pricing = await priceCart({
      address_id: fresh.address_id,
      product_ids_with_quantity: snapshot.product_ids_with_quantity,
      business_user_id: fresh.vendor_id,
      coupon_code: snapshot.coupon_code,
      platform: snapshot.platform,
    });

    const newOrder = await createOrder({
      user_id: fresh.customer_id,
      business_user_id: fresh.vendor_id,
      address_id: fresh.address_id,
      product_ids_with_quantity: snapshot.product_ids_with_quantity,
      pricing,
      payment: PAYMENT_COLUMNS.paid({
        providerTxnId: providerTxnId || fresh.merchant_txn_id,
        // Charge what was quoted at initiate time, so a price change mid-payment
        // can never bill the customer more than PhonePe collected.
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
