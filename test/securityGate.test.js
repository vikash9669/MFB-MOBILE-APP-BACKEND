const test = require("node:test");
const assert = require("node:assert");

// Two settings that were found open on the live backend, both of which the boot
// banner had been warning about for as long as anyone had been reading it.
//
// A warning is not a control. These tests exist so the controls stay controls.

const { productionBlockers, looksPublic } = require("../util/securityGate");

const prod = (extra = {}) => ({
  NODE_ENV: "production",
  JWT_SECRET_KEY: "a-real-48-byte-random-value-nobody-else-has",
  JWT_REFRESH_SECRET_KEY: "a-different-real-random-value",
  ...extra,
});

// ── the signing key ────────────────────────────────────────────────────────

test("a placeholder signing key blocks production startup", () => {
  // The actual production value. Tokens minted on a laptop with no credentials
  // were accepted as staff by the live backend because of this.
  for (const value of ["change_me", "CHANGE_ME_IN_PROD", "dev_access_secret", "your_secret_here"]) {
    const blockers = productionBlockers(prod({ JWT_SECRET_KEY: value }));
    assert.ok(blockers.length > 0, `${value} must block startup`);
    assert.match(blockers[0], /JWT_SECRET_KEY/);
  }
});

test("the refresh key is guarded too — it mints access tokens", () => {
  const blockers = productionBlockers(prod({ JWT_REFRESH_SECRET_KEY: "change_me" }));
  assert.ok(blockers.some((b) => b.includes("JWT_REFRESH_SECRET_KEY")));
});

test("an unset key blocks, rather than being read as 'no default in use'", () => {
  const env = prod();
  delete env.JWT_SECRET_KEY;
  assert.ok(productionBlockers(env).some((b) => b.includes("not set")));
});

test("real secrets start cleanly", () => {
  assert.deepStrictEqual(productionBlockers(prod()), []);
});

test("the gate is production-only, so local work is untouched", () => {
  for (const env of ["development", "test", undefined]) {
    const vars = prod({ NODE_ENV: env, JWT_SECRET_KEY: "change_me" });
    if (env === undefined) delete vars.NODE_ENV;
    assert.deepStrictEqual(productionBlockers(vars), [], `${env} must not be blocked`);
  }
});

test("a secret that merely contains a marker word is still refused", () => {
  // Placeholders get pasted with suffixes far more often than they get replaced.
  assert.strictEqual(looksPublic("change_me_in_prod_2026"), true);
  assert.strictEqual(looksPublic("prefix-dev_access_secret-suffix"), true);
  assert.strictEqual(looksPublic("qX7f2mDkS9pLrE4vN8wYtB3cH6jZ"), false);
});

// ── the OTP bypass ─────────────────────────────────────────────────────────
//
// OTP_DEV_MODE=true means any number accepts the dev code. On production that
// is an unauthenticated takeover of every customer, vendor and rider account,
// and silent — no SMS is sent, so the owner is never told.

const loadOtp = () => {
  delete require.cache[require.resolve("../util/otp")];
  return require("../util/otp");
};

// AWAITS fn before restoring. A non-awaiting version returns the promise, runs
// the restore synchronously, and lets the async body execute under the original
// environment — so the setting under test is gone by the time the assertion
// runs. That cost a real debugging detour here.
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("OTP_DEV_MODE is ignored in production, whatever the env says", async () => {
  await withEnv(
    { NODE_ENV: "production", OTP_DEV_MODE: "true", OTP_DEV_NUMBERS: "", OTP_DEV_CODE: "123456" },
    async () => {
      const otp = loadOtp();
      // isDevCode is the observable consequence: it is what lets the dev code
      // stand in for a real one.
      assert.strictEqual(otp.isDevCode("123456"), false, "the dev code must not be honoured in production");
    }
  );
});

test("OTP_DEV_MODE still works outside production, so local testing is unaffected", async () => {
  await withEnv(
    { NODE_ENV: "development", OTP_DEV_MODE: "true", OTP_DEV_CODE: "123456" },
    async () => {
      const otp = loadOtp();
      assert.strictEqual(otp.isDevCode("123456"), true);
      assert.strictEqual(otp.isDevCode("999999"), false, "only the configured code");
    }
  );
});

test("a named QA number still bypasses in production — that is the supported route", async () => {
  // Deliberately NOT closed. A short list of known test numbers is a different
  // risk from "every number in existence", and it is what production testing
  // should use instead of the blanket switch.
  await withEnv(
    {
      NODE_ENV: "production",
      OTP_DEV_MODE: "false",
      OTP_DEV_NUMBERS: "9000000001",
      OTP_DEV_CODE: "123456",
    },
    async () => {
      const otp = loadOtp();
      const sent = await otp.initiateOtp("9000000001", "SMS");
      assert.match(String(sent.requestId), /^dev:/, "a whitelisted number must not hit the provider");
      const ok = await otp.verifyOtp("9000000001", sent.requestId, "123456");
      assert.strictEqual(ok.verified, true);
    }
  );
});
