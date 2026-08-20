# Message templates — WhatsApp, SMS, email

Every template this system needs, written against the provider rules as they
stand in August 2026, with the exact payloads to submit and the code changes
each one implies.

**Read the first section before submitting anything.** Two of the three channels
have no template review at all, and the third rejects most first submissions for
a reason that is already documented in this codebase.

---

## What can actually be "sent for review"

| Channel | Review process? | Blocked on |
| --- | --- | --- |
| WhatsApp | **Yes** — Meta reviews every template, ~48h | Meta Business Verification (not done) |
| SMS | **No template review.** A2P 10DLC campaign registration reviews your *brand and samples*, not templates | Only if you register US-bound traffic |
| Email | **None.** SendGrid never reviews template content | Nothing — only Sender Identity, already done |

So "send all three for review" is really one submission (WhatsApp), one
registration that may not apply to you (SMS), and nothing at all for email.

### Why I could not submit the WhatsApp templates for you

Submitting a template for WhatsApp approval requires a WhatsApp Business Account
linked to an approved Sender. This account is still on the Twilio **sandbox** —
there is no WABA behind it, so the submission call fails before Meta ever sees
it. Meta Business Verification has to clear first.

Everything below is ready to paste the moment it does.

---

## 1. WhatsApp — delivery code (the blocking one)

### Why the last two submissions were rejected

The rejections were almost certainly `INCORRECT_CATEGORY`, and they would repeat
on a third UTILITY attempt. Meta routes anything that looks like a one-time code
into the **AUTHENTICATION** category automatically, and that category is not a
template you write — Meta owns the body:

> Fixed, non-customizable preset text: `<VERIFICATION_CODE> is your verification code`

You cannot add the rider's name, the order number, or your own wording. A
COPY_CODE button is mandatory. One variable, the code itself, under 15
characters.

That is the whole template. There is nothing to design, which is the good news:
it is nearly impossible to get rejected once submitted in the right category.

### Payload

`POST https://content.twilio.com/v1/Content` (Basic auth: Account SID / Auth Token)

```json
{
  "friendly_name": "mfb_delivery_code",
  "language": "en",
  "types": {
    "whatsapp/authentication": {
      "add_security_recommendation": true,
      "actions": [
        { "type": "COPY_CODE", "copy_code_text": "Copy code" }
      ]
    }
  }
}
```

Then submit it for WhatsApp approval and put the returned `HX…` SID in
`TWILIO_WA_OTP_CONTENT_SID`.

**`code_expiration_minutes` is deliberately omitted.** It renders "This code
expires in N minutes", and our delivery code does not expire — it lives as long
as the order does. Meta allows 1–90 minutes; every value would be a lie to the
customer, and a code that still works after the message says it expired is worse
than no expiry line at all.

### Code change — already applied

`sendDeliveryOtp` was sending three variables:

```js
contentVariables: { 1: who, 2: String(orderId), 3: String(otp) }
```

An authentication template accepts exactly one. Three would fail the send
outright, so this is now `{ 1: String(otp) }`. The rider name and order number
survive on the SMS leg, which is untouched — the code is the part that matters
at the door.

---

## 2. WhatsApp — vendor alerts (a gap you have not hit yet)

### The problem

`util/vendorAlerts.js` sends WhatsApp as **free-form `Body:` text with no
template support at all**. That works today only because the sandbox is
permissive. The moment you move to a live sender, every vendor alert outside a
24-hour customer-initiated window fails with:

> 63016 — Failed to send freeform message because you are outside the allowed
> window. Please use a Template.

A vendor never messages you first, so the window is never open. **Every vendor
WhatsApp alert will fail silently in production** until these are templated.

These four are UTILITY, not AUTHENTICATION — they are transactional updates
about an order, which is exactly what UTILITY is for.

### Formatting rules these are written to satisfy

Meta rejects a body that **begins or ends with a variable**, and rejects
templates whose text is mostly placeholders. Every template below opens and
closes with fixed words for that reason. Template names must be lowercase
alphanumeric with underscores.

### 2a. `mfb_vendor_new_order`

Category **UTILITY**. Variables: 1 shop, 2 order number, 3 item count, 4 total.

```
New order at {{1}}. Order #{{2}} — {{3}} item(s), total Rs {{4}}. Please open
your dashboard to accept it and start preparing. Thank you.
```

### 2b. `mfb_vendor_order_reminder`

Category **UTILITY**. Variables: 1 order number, 2 shop, 3 minutes waiting.

Kept separate from 2a rather than adding a "is this a reminder" variable — a
variable that changes what the message *means* is a common rejection trigger,
and the two need different urgency wording anyway.

```
Reminder about order #{{1}} at {{2}}. It has not been accepted for {{3}}
minutes and a customer is waiting. Please open your dashboard to accept or
decline it now.
```

### 2c. `mfb_admin_vendor_unresponsive`

Category **UTILITY**. Variables: 1 order number, 2 shop, 3 minutes waiting.

```
Escalation for order #{{2}}. The store {{2}} has not responded for {{3}}
minutes. Please review this order in the admin panel and contact the store or
reassign it.
```

### 2d. `mfb_admin_order_cancelled`

Category **UTILITY**. Variables: 1 order number, 2 shop, 3 amount.

```
Order #{{1}} at {{2}} was cancelled automatically because the store did not
accept it in time. A refund of Rs {{3}} has been started. Please review this in
the admin panel.
```

### Payload shape for all four

```json
{
  "friendly_name": "mfb_vendor_new_order",
  "language": "en",
  "variables": { "1": "Sharma Restaurant", "2": "272403", "3": "2", "4": "250" },
  "types": {
    "twilio/text": {
      "body": "New order at {{1}}. Order #{{2}} — {{3}} item(s), total Rs {{4}}. Please open your dashboard to accept it and start preparing. Thank you."
    }
  }
}
```

The `variables` map is the sample values Meta reviews against — realistic ones
approve faster than `x` and `123`.

### Code change still needed

`whatsappVendor()` takes a `body` string and has no `ContentSid` path. Wiring
these means giving it the same template-or-freeform branch that
`util/customerAlerts.js` already has, plus four new env vars. Not done — say the
word and I will, but it needs the four SIDs to be worth switching on.

---

## 3. SMS

**There is no SMS template review.** Twilio does not approve message bodies.

What exists is **A2P 10DLC campaign registration**, which vets your *brand*,
opt-in process, and a handful of sample messages — and it governs **US-bound**
traffic. Your traffic is India-bound, so it likely does not apply. Worth
confirming with Twilio support rather than assuming, because the answer
determines whether your number gets filtered.

### The real SMS risk, which registration will not fix

You are sending from a **US +1 long code to Indian handsets**. India's DLT
registration — the thing that makes A2P SMS deliverable there — only applies to
Indian sender IDs. A US long code cannot register for it. Indian carriers filter
unregistered international A2P traffic aggressively.

It reached your phone in testing. At volume it will not reach everyone, and the
failures will look random. `MSGPROVIDER=msg91` is already wired in
`util/otp.js` for exactly this, though note it only covers OTP login, not these
alert messages.

### Sample messages, if you do register

Use case: **Account Notification / 2FA**, transactional, no marketing.

```
Your My First Bite verification code is 123456. Do not share this code.

Ramesh is on the way with order #272403. Share this code at the door to receive
it: 8174. My First Bite will never ask for this code over a call.

New order #272403 at Sharma Restaurant. 2 items, total Rs 250. Open your
dashboard to accept it.
```

Opt-in description: *"Customers and delivery partners provide their mobile
number when creating an account in the My First Bite app and consent to
receiving transactional order and verification messages. No marketing messages
are sent."*

---

## 4. Email

**SendGrid does not review or approve template content.** There is no submission
to make. The only requirement is a verified Sender Identity, and yours is
already set — `EMAIL_FROM` is verified and mail sends.

### The one upgrade worth making

You are on **Single Sender Verification**, which SendGrid explicitly recommends
for testing rather than production. **Domain Authentication** adds SPF and DKIM
via three CNAME records in your DNS, and it is the difference between landing in
the inbox and landing in spam once volume picks up.

Sender Authentication → Authenticate Your Domain → add the CNAMEs → verify.
`EMAIL_FROM` then becomes an address on that domain rather than a gmail one.

### Compliance note

These are transactional messages — order confirmations and operational alerts —
so CAN-SPAM's unsubscribe-link and physical-address requirements do not apply.
They do apply the moment a single promotional line is added, so keep offers out
of these templates.

The email bodies themselves already exist as HTML in
`controllers/admin/notify.js` and need no rework.

---

## Order of operations

1. **Meta Business Verification.** Everything WhatsApp waits on this.
2. **Register the WhatsApp sender** in Twilio → Messaging → Senders.
3. **Submit `mfb_delivery_code`** (section 1). ~48h. Set
   `TWILIO_WA_OTP_CONTENT_SID`, then flip `CUSTOMER_ALERT_CHANNELS` back to
   `whatsapp,sms`.
4. **Submit the four vendor templates** (section 2), then ask me to wire
   `whatsappVendor()` to use them.
5. **Domain Authentication** in SendGrid (section 4) — independent of all the
   above, do it whenever.
6. **Ask Twilio** whether A2P 10DLC applies to India-bound traffic (section 3).

Steps 1–4 are sequential. 5 and 6 are not, and 5 is the highest
value-per-minute item on the list.
