const test = require("node:test");
const assert = require("node:assert");

const { forSms } = require("../util/vendorAlerts");

// Vendor alerts over SMS.
//
// The alert copy is authored for WhatsApp, and two of its habits cost real
// money over SMS. Asterisks are WhatsApp bold markup and arrive as literal
// characters. Anything outside GSM-7 — an emoji, a rupee sign, even a middle
// dot — re-encodes the ENTIRE message as UCS-2, dropping the segment size from
// 160 characters to 70. One decorative character can double the bill on every
// order alert the platform ever sends.
//
// A message is GSM-7 safe here if every character is printable ASCII or a
// newline. That is stricter than the real alphabet (which has some accented
// extras) and deliberately so: passing this test guarantees single-byte
// encoding, and the cost of being strict is nil for our own copy.
const gsm7Safe = (s) =>
  [...s].every((ch) => {
    const c = ch.codePointAt(0);
    return (c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x0d;
  });

test("WhatsApp bold markers do not survive into SMS", () => {
  // Otherwise the vendor reads "*New order #272403*" with the asterisks.
  assert.equal(forSms("*New order #99* at Shop"), "New order #99 at Shop");
});

test("the rupee sign becomes Rs", () => {
  // ₹ is not in GSM-7 and alone would force UCS-2 on the whole message.
  const out = forSms("Total ₹250");
  assert.equal(out, "Total Rs 250");
  assert.ok(gsm7Safe(out));
});

test("emoji are stripped, including the variation-selector kind", () => {
  // 🛎️ is an emoji plus U+FE0F; leaving the selector behind would still be
  // non-GSM-7 and the message would still cost double.
  const out = forSms("🛎️ New order 🚨 now ⏳");
  assert.ok(gsm7Safe(out), `not GSM-7 safe: ${JSON.stringify(out)}`);
  assert.equal(out, "New order now");
});

test("decorative punctuation from our own copy is normalised", () => {
  // Found by sending a real alert: "2 items · Rs 250" was GSM-7 clean except
  // for the separator, which pushed a 128-character message to two segments.
  const out = forSms("2 items · Rs 250 — done… “quoted” it’s");
  assert.ok(gsm7Safe(out), `not GSM-7 safe: ${JSON.stringify(out)}`);
  assert.ok(out.includes("2 items - Rs 250"));
});

test("a real order alert fits in one segment", () => {
  const body =
    "🛎️ *New order #272403* at Sharma Restaurant\n2 items · ₹250\n\n" +
    "Please accept it and start preparing:\nhttp://panel/vendor/portal/orders";
  const out = forSms(body);
  assert.ok(gsm7Safe(out), `not GSM-7 safe: ${JSON.stringify(out)}`);
  assert.ok(out.length <= 160, `${out.length} chars would split into two segments`);
});

test("caller-supplied text is left alone even when it is not GSM-7", () => {
  // A vendor's name in Devanagari is worth an extra segment; a middle dot is
  // not. Only our own typography gets normalised — never the data.
  const out = forSms("New order at शर्मा भोजनालय");
  assert.ok(out.includes("शर्मा भोजनालय"), "the vendor's name must survive intact");
});

test("blank lines are collapsed but paragraph breaks survive", () => {
  // Stripping a leading emoji leaves ragged whitespace behind.
  assert.equal(forSms("🚨 Order\n\n\n\nDetails"), "Order\n\nDetails");
});

test("junk in does not throw", () => {
  for (const v of [null, undefined, "", 0, {}]) {
    assert.doesNotThrow(() => forSms(v));
  }
});
