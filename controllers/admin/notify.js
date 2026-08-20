// Order notifications — administration/Notifications::orderReceived.
//
// The PHP version emailed two people when an order came in: the assigned rider
// ("collect this order from the vendor") and the vendor ("make this order
// ready"). Reproduced with the same recipients and the same message, using the
// backend's existing nodemailer transport rather than a second SMTP config.
const { sendMail, mailFrom, mailConfigured, recipientList } = require("../../util/email");
const { blocked } = require("../../util/liveSend");
const { StoreOrders, StoreOrderDetails, User, Business } = require("../../models");
const {
  alertVendorNewOrder,
  alertAdminVendorUnresponsive,
  alertAdminAutoCancelled,
} = require("../../util/vendorAlerts");

const STORE = process.env.STORE_NAME || "My First Bite";
// The address readers are told to write to. Not EMAIL_USER: on SendGrid that
// is the literal string "apikey", which rendered as "Mail us: apikey".
const SUPPORT_EMAIL = () => mailFrom();
const SITE_URL = process.env.STORE_URL || "https://www.myfirstbite.in";

// Where the panel is served. The mail's whole purpose is to get someone to the
// screen where they can act, so a wrong origin here makes the mail useless.
const trimTrailingSlashes = (s) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end -= 1;
  return s.slice(0, end);
};
const PANEL_URL = trimTrailingSlashes(process.env.PANEL_URL || "http://localhost:5173");

// Admin staff are roles 0/1/2 (see middlewares/verifyAdmin.js).
const ADMIN_ROLES = [0, 1, 2];

// store_orders.rider_id defaults to 1 at placement (util/orders.js) — a
// placeholder, not a real assignment. Mailing it would send "collect this
// order" to whoever happens to be user 1. Only notify a genuinely assigned rider.
const UNASSIGNED_RIDER_ID = 1;

// Who gets the "new order placed" alert. Every admin account by default, but
// this database has six of them, and one mail each per order is both slow and
// a good way to get an SMTP account rate-limited. ORDER_ALERT_EMAILS narrows it
// to the people who actually watch the queue.
const alertRecipients = (adminUsers) => {
  const configured = (process.env.ORDER_ALERT_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  return adminUsers.map((a) => a.user_email).filter(Boolean);
};

// Deep links into the two portals. A vendor's orders list is where they change
// an order's status — that is what "accepting" is in this panel — while an
// admin gets the fuller per-order screen.
const vendorOrdersUrl = () => `${PANEL_URL}/vendor/portal/orders`;
const adminOrderUrl = (orderId) => `${PANEL_URL}/admin/orders/${orderId}`;

// A prominent link, since these mails are read on phones where a bare URL in a
// paragraph gets missed.
const button = (href, label) =>
  `<p style="margin:22px 0">
     <a href="${href}" style="background:#E4122F;color:#fff;text-decoration:none;
        padding:12px 22px;border-radius:24px;display:inline-block;font-weight:600">${label}</a>
   </p>
   <p style="font-size:12px;color:#888;word-break:break-all">Or paste this into your browser:<br>${href}</p>`;

const shell = (orderId, greeting, body) => `<!DOCTYPE html>
<html><body style="font-family:Calibri,Arial,sans-serif;color:#222">
  <table width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;margin:auto">
    <tr>
      <td><h2 style="margin:0;color:#ff6b00">${STORE}</h2></td>
      <td align="right"><h3 style="margin:0;font-style:italic">ORDER #${orderId}</h3></td>
    </tr>
    <tr><td colspan="2"><hr style="border:none;border-top:1px solid #eee"></td></tr>
    <tr><td colspan="2" style="font-size:14px;line-height:1.6">
      <p>Hello ${greeting},</p>
      ${body}
      <p>Thank you,</p>
    </td></tr>
    <tr><td colspan="2" style="font-size:13px;color:#666;padding-top:12px">
      <p>${STORE} Team<br>
      ${SUPPORT_EMAIL() ? `Mail us: ${SUPPORT_EMAIL()}<br>` : ""}
      <a href="${SITE_URL}" style="color:#ff6b00">${SITE_URL}</a></p>
    </td></tr>
  </table>
</body></html>`;

// Sends one mail, never throwing — a failed notification must not fail the
// request that triggered it.
//
// This always attempts a real send. There is no dry-run mode: mail either goes
// out or the reason it did not is returned to the caller and logged.
async function send(to, subject, html) {
  if (!to) return { sent: false, reason: "no address on file" };

  // Vendor, rider, customer and admin mail all pass through here.
  //
  // `to` may be several addresses joined with commas — admin alerts go to
  // everyone in one message rather than one message each. So the allowlist is
  // applied per address and the send continues to whoever survives, instead of
  // hashing the joined string (which matches nobody and refused the lot).
  const recipients = recipientList(to);
  const allowed = recipients.filter((r) => !blocked(r, "email"));
  if (allowed.length === 0) {
    return { sent: false, blocked: true, reason: "recipient not in LIVE_SEND_ALLOWLIST" };
  }

  // A transport alone is not enough: this used to pass with a host and no
  // credentials, so every send attempted an authentication it could not do.
  if (!mailConfigured()) return { sent: false, reason: "email not configured" };

  const result = await sendMail({ to: allowed.join(", "), subject, html });
  if (!result.sent) {
    console.log("MFB-error-logs ~ notify send ~", result.reason);
  }
  return result;
}

// Mails the rider and the vendor about one order. Callable directly, because
// the PHP fired this from Orders::OrderUpdate the moment a rider was assigned —
// not only from an explicit button. Returns null when the order does not exist.
async function notifyOrderReceived(orderId) {
  const order = await StoreOrders.findByPk(orderId, { raw: true });
  if (order == null) return null;

  const [rider, vendorUser, business] = await Promise.all([
    order.rider_id ? User.findByPk(order.rider_id, { raw: true }) : null,
    order.vendor_id ? User.findByPk(order.vendor_id, { raw: true }) : null,
    order.vendor_id ? Business.findOne({ where: { user_id: order.vendor_id }, raw: true }) : null,
  ]);

  // Skip the rider mail when no real rider is assigned yet, which is always
  // the case at the moment an order is placed.
  const riderAssigned =
    order.rider_id != null && Number(order.rider_id) !== UNASSIGNED_RIDER_ID;

  const riderResult = riderAssigned
    ? await send(
        rider?.user_email,
        `Order Received at ${STORE}`,
        shell(
          order.order_id,
          rider?.user_name || "there",
          `<p>You have received a request from ${STORE} to deliver an order to a customer's address.
            Please collect it from the vendor and deliver it on time.</p>
           <p>If you are not available to deliver this order, please let the ${STORE} team know.</p>`
        )
      )
    : { sent: false, reason: "no rider assigned yet" };

  const vendorResult = await send(
    vendorUser?.user_email,
    `New order #${order.order_id} — action needed`,
    shell(
      order.order_id,
      business?.business_name || vendorUser?.user_name || "there",
      `<p>You have received a request from ${STORE} to prepare an order for a customer.
        Please make it ready as soon as possible — a rider will reach you shortly to collect it.</p>
       <p><strong>Open your dashboard to accept this order and move it along:</strong></p>
       ${button(vendorOrdersUrl(), "Accept order in dashboard")}
       <p>If you cannot fulfil this order, please let the ${STORE} team know.</p>`
    )
  );

  // Admin staff, so someone at head office knows an order landed even if the
  // vendor is slow to look. Roles 0/1/2 all count as admin.
  const admins = await User.findAll({
    where: { user_role: ADMIN_ROLES },
    attributes: ["user_id", "user_name", "user_email"],
    raw: true,
  });

  // One message to everyone rather than one message each: six admin accounts
  // times every order is six SMTP round-trips per checkout and a fast route to
  // being rate-limited.
  const recipients = alertRecipients(admins);
  const adminResult = await send(
    recipients.join(", "),
    `New order #${order.order_id} placed`,
    shell(
      order.order_id,
      "team",
      `<p>A new order has been placed at <strong>${
        business?.business_name || vendorUser?.user_name || "a vendor"
      }</strong>.</p>
       <p>The vendor has been emailed to accept it. Open the order if you need to
         track, reassign or intervene.</p>
       ${button(adminOrderUrl(order.order_id), "View order in admin panel")}`
    )
  );

  // WhatsApp + a phone call to the vendor. Both are opt-in and both swallow
  // their own failures — a vendor who can't be reached by phone must not stop
  // an order that is already placed and possibly already paid for.
  const items = await StoreOrderDetails.findAll({
    where: { order_id: order.order_id },
    attributes: ["product_qty"],
    raw: true,
  });
  const itemCount = items.reduce((n, i) => n + Number(i.product_qty || 1), 0);

  const vendorAlerts = await alertVendorNewOrder({
    orderId: order.order_id,
    vendorName: business?.business_name || vendorUser?.user_name,
    phone: vendorUser?.user_phone,
    itemCount,
    total:
      Number(order.order_amount || 0) +
      Number(order.delivery_charges || 0) -
      Number(order.order_discount || 0),
    acceptUrl: vendorOrdersUrl(),
  });

  return {
    rider: { email: rider?.user_email ?? null, ...riderResult },
    vendor: {
      email: vendorUser?.user_email ?? null,
      ...vendorResult,
      whatsapp: vendorAlerts.whatsapp,
      sms: vendorAlerts.sms,
      call: vendorAlerts.call,
    },
    admins: { count: recipients.length, ...adminResult },
  };
}

// POST /admin/notifications/order-received/:orderId
exports.orderReceived = async (req, res) => {
  try {
    const result = await notifyOrderReceived(req.params.orderId);
    if (result == null) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Resend means resend everywhere. This button sat next to the rider
    // dropdown and only ever re-sent email, so an operator chasing a rider who
    // had not responded was re-sending mail to a phone-first courier and
    // wondering why nothing happened. Same path as assignment, so the two
    // buttons cannot drift apart.
    const order = await StoreOrders.findByPk(req.params.orderId, { raw: true });
    let dispatched = null;
    if (order?.rider_id != null && Number(order.rider_id) !== UNASSIGNED_RIDER_ID) {
      const { assignToPanelRider } = require("../../util/riderAssignment");
      dispatched = await assignToPanelRider(order.order_id, order.rider_id);
    }

    res.json({ message: "Notifications processed", ...result, dispatched });
  } catch (err) {
    console.log("MFB-error-logs ~ orderReceived ~ err:", err);
    res.status(500).json({ message: "Failed to send notifications" });
  }
};

/**
 * Tells admin staff a vendor has stopped responding.
 *
 * Sent once per order, after the reminder ladder in util/orderAcceptSweeper.js
 * is exhausted. At this point the vendor has had the panel bell, an email, and
 * every enabled WhatsApp/call reminder, and still nobody has moved the order —
 * so it needs a person, not another automated nudge.
 */
async function escalateUnaccepted(orderId, minutesWaiting, cancelAfterMin = 0) {
  const order = await StoreOrders.findByPk(orderId, { raw: true });
  if (order == null) return null;
  if (Number(order.order_status) !== 0) return { skipped: "already accepted" };

  const [vendorUser, business, admins] = await Promise.all([
    order.vendor_id ? User.findByPk(order.vendor_id, { raw: true }) : null,
    order.vendor_id
      ? Business.findOne({ where: { user_id: order.vendor_id }, raw: true })
      : null,
    User.findAll({
      where: { user_role: ADMIN_ROLES },
      attributes: ["user_email"],
      raw: true,
    }),
  ]);

  const shop = business?.business_name || vendorUser?.user_name || "the vendor";
  const minutesUntilCancel = Math.max(0, Number(cancelAfterMin || 0) - Number(minutesWaiting));

  const plural = minutesUntilCancel === 1 ? "" : "s";
  const deadlineHtml =
    minutesUntilCancel > 0
      ? `<p style="color:#b00020"><strong>This order auto-cancels in
           ${minutesUntilCancel} minute${plural}</strong>, and any online payment
           is refunded automatically.</p>`
      : "";

  // Email and WhatsApp together: email carries the detail, WhatsApp is what
  // actually gets looked at inside the cancellation window.
  const [mail, whatsapp] = await Promise.all([
    send(
      alertRecipients(admins).join(", "),
      `⚠️ Order #${orderId} not accepted after ${minutesWaiting} minutes`,
      shell(
        orderId,
        "team",
        `<p><strong>${shop}</strong> has not accepted order #${orderId}, ${minutesWaiting}
           minutes after it was placed.</p>
         <p>They have already had the dashboard alert, an email and every reminder
           we send. The customer is still waiting — someone needs to call the shop
           or move this order elsewhere.</p>
         ${deadlineHtml}
         ${vendorUser?.user_phone ? `<p>Vendor phone: ${vendorUser.user_phone}</p>` : ""}
         ${button(adminOrderUrl(orderId), "Open order in admin panel")}`
      )
    ),
    alertAdminVendorUnresponsive({
      orderId,
      shop,
      vendorPhone: vendorUser?.user_phone,
      minutesWaiting,
      minutesUntilCancel,
      orderUrl: adminOrderUrl(orderId),
    }).catch((err) => ({ sent: false, reason: err.message })),
  ]);

  return { mail, whatsapp };
}

/**
 * Tells admin staff an order was auto-cancelled, and whether the money went
 * back. A failed refund is the part a human must act on, so it is stated
 * plainly rather than buried in the body.
 */
async function notifyOrderAutoCancelled(orderId, { refunded, amount }) {
  const order = await StoreOrders.findByPk(orderId, { raw: true });
  if (order == null) return null;

  const [vendorUser, business, admins] = await Promise.all([
    order.vendor_id ? User.findByPk(order.vendor_id, { raw: true }) : null,
    order.vendor_id
      ? Business.findOne({ where: { user_id: order.vendor_id }, raw: true })
      : null,
    User.findAll({
      where: { user_role: ADMIN_ROLES },
      attributes: ["user_email"],
      raw: true,
    }),
  ]);

  const shop = business?.business_name || vendorUser?.user_name || "the vendor";

  let money = "<p>This was a cash order, so there is nothing to refund.</p>";
  if (refunded === true) {
    money = `<p>₹${amount} has been submitted to PhonePe as a refund. It usually
               reaches the customer in 3–5 working days.</p>`;
  } else if (refunded === false) {
    money = `<p style="color:#b00020"><strong>₹${amount} was paid online and the
               refund did not go through.</strong> This one needs refunding by
               hand from the PhonePe dashboard.</p>`;
  }

  const [mail, whatsapp] = await Promise.all([
    send(
      alertRecipients(admins).join(", "),
      `❌ Order #${orderId} auto-cancelled — ${shop} never accepted it`,
      shell(
        orderId,
        "team",
        `<p>Order #${orderId} was cancelled automatically because <strong>${shop}</strong>
           did not accept it inside the acceptance window.</p>
         ${money}
         <p>The customer has been notified in the app.</p>
         ${button(adminOrderUrl(orderId), "Open order in admin panel")}`
      )
    ),
    alertAdminAutoCancelled({
      orderId,
      shop,
      refunded,
      amount,
      orderUrl: adminOrderUrl(orderId),
    }).catch((err) => ({ sent: false, reason: err.message })),
  ]);

  return { mail, whatsapp };
}

exports.notifyOrderReceived = notifyOrderReceived;
exports.escalateUnaccepted = escalateUnaccepted;
exports.notifyOrderAutoCancelled = notifyOrderAutoCancelled;
