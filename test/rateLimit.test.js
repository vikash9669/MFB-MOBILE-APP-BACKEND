const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { createLimiter, normalisePhone, clientIp } = require("../middlewares/rateLimit");

// Rate limiting.
//
// Two failure modes matter and they pull in opposite directions. Too loose and
// an unlimited caller either spends our Twilio balance or eventually guesses a
// 6-digit OTP. Too tight — or tight in the wrong way — and a real customer who
// mistypes a code once is locked out of their own account, which is a support
// call rather than a security win. Most of what follows is about the second
// one: what must NOT be counted.

// Minimal express-shaped doubles. res extends EventEmitter because the
// failures-only mode hooks res.on("finish"), which is the whole mechanism.
const mkReq = (over = {}) => ({
  body: {},
  headers: {},
  socket: { remoteAddress: "10.0.0.1" },
  ...over,
});

function mkRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.body = null;
  res.json = (payload) => {
    res.body = payload;
    res.emit("finish");
    return res;
  };
  return res;
}

// Runs one request through a limiter and reports whether it was let through.
// `finishWith` is the status the handler would have replied with, which is what
// the failures-only mode keys off.
function call(limiter, req, finishWith = 200) {
  const res = mkRes();
  let passed = false;
  limiter(req, res, () => {
    passed = true;
  });
  if (passed) {
    res.statusCode = finishWith;
    res.emit("finish");
  }
  return { passed, res };
}

test("a spend limiter counts every request, successful or not", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 3,
    key: () => "k",
    message: "no",
  });

  // Sending an SMS costs the same whether the handler ends up happy, so
  // success must not buy another go.
  assert.equal(call(limiter, mkReq(), 200).passed, true);
  assert.equal(call(limiter, mkReq(), 200).passed, true);
  assert.equal(call(limiter, mkReq(), 200).passed, true);
  assert.equal(call(limiter, mkReq(), 200).passed, false, "fourth is over the cap");
});

test("a spend limiter replies 429 with a Retry-After the caller can act on", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 1,
    key: () => "k",
    message: "slow down",
  });

  call(limiter, mkReq());
  const { res } = call(limiter, mkReq());

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.message, "slow down");
  // A 429 with no hint just gets retried immediately in a loop.
  const retry = Number(res.headers["Retry-After"]);
  assert.ok(retry > 0 && retry <= 60, `Retry-After should be within the window, got ${retry}`);
  assert.equal(res.body.retry_after, retry);
});

test("a guard limiter ignores successes entirely", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 2,
    key: () => "k",
    failuresOnly: true,
    message: "no",
  });

  // The person typing their password right is the one caller we know is not
  // attacking. Twenty correct sign-ins must not approach a lockout.
  for (let i = 0; i < 20; i += 1) {
    assert.equal(call(limiter, mkReq(), 200).passed, true, `success ${i} was counted`);
  }
});

test("a guard limiter counts failures and then blocks", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 2,
    key: () => "k",
    failuresOnly: true,
    message: "no",
  });

  assert.equal(call(limiter, mkReq(), 401).passed, true);
  assert.equal(call(limiter, mkReq(), 401).passed, true);
  assert.equal(call(limiter, mkReq(), 401).passed, false, "third wrong guess is refused");
});

test("one success forgives the failures before it", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 3,
    key: () => "k",
    failuresOnly: true,
    message: "no",
  });

  // Fat-fingering a code twice and then getting it right is an ordinary
  // Tuesday. The next time they sign in they should start from zero, not from
  // two, or a normal week accumulates into a lockout.
  call(limiter, mkReq(), 401);
  call(limiter, mkReq(), 401);
  call(limiter, mkReq(), 200);

  for (let i = 0; i < 3; i += 1) {
    assert.equal(call(limiter, mkReq(), 401).passed, true, `guess ${i} after reset`);
  }
  assert.equal(call(limiter, mkReq(), 401).passed, false);
});

test("a malformed request is not a failed guess", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 2,
    key: () => "k",
    failuresOnly: true,
    message: "no",
  });

  // Found by exercising the real reset-password flow: a 400 means the phone had
  // nine digits or the two password boxes disagreed. Counting those meant
  // somebody fumbling the form was locked out for fifteen minutes without ever
  // typing a wrong code. Only a rejected credential — 401/403 — is a guess.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(call(limiter, mkReq(), 400).passed, true, `400 number ${i} was counted`);
  }
  assert.equal(call(limiter, mkReq(), 404).passed, true, "404 is a wrong address, not a wrong answer");

  // 401 and 403 still count, and still block.
  assert.equal(call(limiter, mkReq(), 401).passed, true);
  assert.equal(call(limiter, mkReq(), 403).passed, true);
  assert.equal(call(limiter, mkReq(), 401).passed, false, "two rejected credentials exhaust max=2");
});

test("our own 500 is not held against the caller", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 2,
    key: () => "k",
    failuresOnly: true,
    message: "no",
  });

  // If the OTP provider is down, every verify 500s. Counting those would lock
  // out every user in the country for the length of the outage, on top of the
  // outage.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(call(limiter, mkReq(), 500).passed, true, `500 number ${i} was counted`);
  }
});

test("buckets are independent, so one caller cannot lock out another", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 1,
    key: (req) => req.body.phone,
    message: "no",
  });

  assert.equal(call(limiter, mkReq({ body: { phone: "1111111111" } })).passed, true);
  assert.equal(call(limiter, mkReq({ body: { phone: "1111111111" } })).passed, false);
  // A different number must be untouched by the first one's spending.
  assert.equal(call(limiter, mkReq({ body: { phone: "2222222222" } })).passed, true);
});

test("the window expires and the allowance comes back", () => {
  const limiter = createLimiter({
    name: "t",
    // Short enough to actually wait out in a test.
    windowMs: 20,
    max: 1,
    key: () => "k",
    message: "no",
  });

  assert.equal(call(limiter, mkReq()).passed, true);
  assert.equal(call(limiter, mkReq()).passed, false);

  const until = Date.now() + 40;
  while (Date.now() < until) {
    /* spin — a real timer would make this test async for 40ms of nothing */
  }

  assert.equal(call(limiter, mkReq()).passed, true, "a new window starts clean");
});

test("a null key skips the limiter rather than pooling those requests", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 1,
    key: (req) => req.body.phone || null,
    message: "no",
  });

  // A body with no phone is a 400 the handler will reject anyway. Bucketing
  // them all under one key would let any malformed request from anyone exhaust
  // a shared allowance — a denial of service built out of the defence.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(call(limiter, mkReq()).passed, true);
  }
});

test("phone numbers normalise to one bucket per handset", () => {
  // Otherwise the same phone gets three separate allowances just by varying how
  // the app formats it, and the per-phone cap means nothing.
  assert.equal(normalisePhone("9669901922"), "9669901922");
  assert.equal(normalisePhone("+91 96699 01922"), "9669901922");
  assert.equal(normalisePhone("919669901922"), "9669901922");
  assert.equal(normalisePhone("+919669901922"), "9669901922");
});

test("normalisePhone survives junk without throwing", () => {
  assert.equal(normalisePhone(null), "");
  assert.equal(normalisePhone(undefined), "");
  assert.equal(normalisePhone(""), "");
  assert.equal(normalisePhone("abc"), "");
});

test("clientIp falls back rather than keying everybody under undefined", () => {
  assert.equal(clientIp({ ip: "1.2.3.4" }), "1.2.3.4");
  assert.equal(clientIp({ socket: { remoteAddress: "5.6.7.8" } }), "5.6.7.8");
  assert.equal(clientIp({}), "unknown");
});

test("a 429 never counts toward the limit that produced it", () => {
  const limiter = createLimiter({
    name: "t",
    windowMs: 60_000,
    max: 1,
    key: () => "k",
    failuresOnly: true,
    message: "no",
  });

  call(limiter, mkReq(), 401);
  // Blocked from here on. If each blocked call bumped the counter, the window
  // would keep extending itself and a caller hammering the endpoint could never
  // get back in — the lockout would outlive the abuse indefinitely.
  for (let i = 0; i < 5; i += 1) call(limiter, mkReq());

  limiter.reset("k");
  assert.equal(call(limiter, mkReq(), 401).passed, true);
});

// ── The shipped limiters, not the factory ──────────────────────────────────
//
// Everything above tests createLimiter with flags passed in explicitly. That
// passed while four of the seven guard limiters were missing `failuresOnly`,
// because the tests never exercised the objects that actually get mounted on a
// route. A live smoke test caught it: twenty *correct* OTP verifications in a
// row hit the cap and locked the account.
//
// So these tests use the real exports. The property under test is not "does the
// factory work" but "is each shipped limiter configured for the risk it
// guards" — a spend limiter must count every call, a secret guard must count
// only wrong answers.
const limiters = require("../middlewares/rateLimit");

// Drives one exported limiter with a realistic body until it blocks, and
// reports how many got through. Each call starts from a cleared bucket.
function runUntilBlocked(limiter, body, finishWith, cap = 200) {
  limiter.clear();
  let allowed = 0;
  for (let i = 0; i < cap; i += 1) {
    const req = mkReq({ body, panel: { user_id: 7 }, user: { dp_id: 7, user_id: 7 } });
    if (!call(limiter, req, finishWith).passed) return allowed;
    allowed += 1;
  }
  return Infinity;
}

const OTP_BODY = { phone_number: "9669901922", user_otp: "000000" };
const LOGIN_BODY = { username: "someone@example.com", password: "x" };

test("secret guards never count a success", () => {
  // If any of these is finite, that limiter is counting correct answers and
  // will lock out a legitimate user who simply signs in often enough.
  const guards = [
    ["otpVerify", limiters.otpVerify, OTP_BODY],
    ["loginPerAccount", limiters.loginPerAccount, LOGIN_BODY],
    ["loginPerIp", limiters.loginPerIp, LOGIN_BODY],
    ["passwordChange", limiters.passwordChange, {}],
    ["adminKey", limiters.adminKey, {}],
    ["deliveryCode", limiters.deliveryCode, { otp: "1234" }],
    ["tokenRefresh", limiters.tokenRefresh, { refreshToken: "x" }],
  ];

  for (const [name, limiter, body] of guards) {
    assert.equal(
      runUntilBlocked(limiter, body, 200),
      Infinity,
      `${name} counted successful requests — a real user will be locked out`
    );
  }
});

test("secret guards do block repeated failures", () => {
  // The other half of the same property: failuresOnly must not mean "never
  // counts anything".
  const guards = [
    ["otpVerify", limiters.otpVerify, OTP_BODY],
    ["loginPerAccount", limiters.loginPerAccount, LOGIN_BODY],
    ["passwordChange", limiters.passwordChange, {}],
    ["adminKey", limiters.adminKey, {}],
    ["deliveryCode", limiters.deliveryCode, { otp: "1234" }],
  ];

  for (const [name, limiter, body] of guards) {
    const allowed = runUntilBlocked(limiter, body, 401);
    assert.ok(
      Number.isFinite(allowed) && allowed > 0 && allowed <= 50,
      `${name} allowed ${allowed} wrong answers before blocking`
    );
  }
});

test("spend limiters count every call, because every call costs money", () => {
  // The inverse mistake: if one of these were failuresOnly, a successful send
  // would be free and the SMS bill would be unbounded.
  const spenders = [
    ["otpSendPerPhone", limiters.otpSendPerPhone, { phone_number: "9669901922" }],
    ["otpSendPerIp", limiters.otpSendPerIp, { phone_number: "9669901922" }],
    ["register", limiters.register, { phone: "9669901922" }],
    ["placesLookup", limiters.placesLookup, {}],
  ];

  for (const [name, limiter, body] of spenders) {
    const allowed = runUntilBlocked(limiter, body, 200);
    assert.ok(
      Number.isFinite(allowed),
      `${name} let unlimited successful requests through — each one is a real cost`
    );
  }
});

test("the customer and partner apps share one OTP allowance per phone", () => {
  // Both apps post to their own /get-otp but hit the same Twilio account for
  // the same handset. Separate buckets would double the cap for free.
  limiters.otpSendPerPhone.clear();
  const cap = 5; // OTP_SEND_MAX_PER_PHONE default
  for (let i = 0; i < cap; i += 1) {
    // Alternating the two apps' body shapes and phone formats.
    const body = i % 2 ? { phone_number: "+919669901922" } : { phone: "9669901922" };
    assert.equal(call(limiters.otpSendPerPhone, mkReq({ body })).passed, true);
  }
  assert.equal(
    call(limiters.otpSendPerPhone, mkReq({ body: { phone_number: "9669901922" } })).passed,
    false,
    "the sixth send for this handset should be refused whichever app asked"
  );
  limiters.otpSendPerPhone.clear();
});
