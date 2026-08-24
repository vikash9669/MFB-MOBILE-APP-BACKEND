const test = require("node:test");
const assert = require("node:assert");

// The provider selector. What matters here is that switching provider is total
// — no caller keeps talking to the old one — and that an unset or misspelt
// PAYMENT_PROVIDER cannot leave the process in a state where it silently takes
// money through something nobody configured.

const withEnv = (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const gateway = require("../util/gateway");

// ── selection ──────────────────────────────────────────────────────────────

test("an unset PAYMENT_PROVIDER keeps the behaviour a deployment already had", () => {
  withEnv({ PAYMENT_PROVIDER: undefined }, () => {
    assert.equal(gateway.name, "phonepe");
  });
});

test("PAYMENT_PROVIDER selects, and is case and whitespace tolerant", () => {
  for (const value of ["cashfree", "CASHFREE", "  Cashfree  "]) {
    withEnv({ PAYMENT_PROVIDER: value }, () => {
      assert.equal(gateway.name, "cashfree", `"${value}" should select cashfree`);
    });
  }
});

test("a misspelt provider falls back to phonepe rather than crashing at checkout", () => {
  withEnv({ PAYMENT_PROVIDER: "cashfreee" }, () => {
    assert.equal(gateway.name, "phonepe");
    assert.doesNotThrow(() => gateway.isConfigured());
  });
});

test("selection is re-read per call, so a switch takes effect without a restart", () => {
  withEnv({ PAYMENT_PROVIDER: "phonepe" }, () => {
    assert.equal(gateway.name, "phonepe");
  });
  withEnv({ PAYMENT_PROVIDER: "cashfree" }, () => {
    assert.equal(gateway.name, "cashfree");
  });
});

// ── interface parity ───────────────────────────────────────────────────────
// Every caller is written against this shape. A driver that quietly lacks a
// method fails at the moment somebody pays, which is the worst time to find out.

const INTERFACE = [
  "isConfigured",
  "config",
  "createSdkOrder",
  "createHostedCheckout",
  "qrConfigured",
  "createUpiQr",
  "fetchStatus",
  "qrFetchStatus",
  "refundPayment",
  "fetchRefundStatus",
  "verifyCallbackAuth",
  "parseCallback",
  "verifyQrCallback",
  "parseQrCallback",
];

test("every driver implements the whole interface", () => {
  for (const [name, driver] of Object.entries(gateway.DRIVERS)) {
    for (const method of INTERFACE) {
      assert.equal(
        typeof driver[method],
        "function",
        `driver "${name}" is missing ${method}()`
      );
    }
  }
});

test("the module re-exports every interface method as a plain function", () => {
  for (const method of INTERFACE) {
    assert.equal(typeof gateway[method], "function", `gateway.${method} should be callable`);
  }
});

// ── refund vocabulary ──────────────────────────────────────────────────────
// PhonePe says COMPLETED, Cashfree says SUCCESS. Both mean the money moved, and
// string-matching one of them in a caller is how refunded_at stops being
// stamped after a provider switch.

test("both providers' terminal refund words are recognised", () => {
  assert.equal(gateway.isRefundSettled("COMPLETED"), true, "phonepe");
  assert.equal(gateway.isRefundSettled("SUCCESS"), true, "cashfree");
  assert.equal(gateway.isRefundSettled("success"), true, "case insensitive");
});

test("in-flight and failed refund states are not treated as settled", () => {
  for (const state of ["PENDING", "ONHOLD", "FAILED", "CANCELLED", "UNKNOWN", "", null, undefined]) {
    assert.equal(gateway.isRefundSettled(state), false, `${state} must not settle`);
  }
});

// ── doorstep QR gating ─────────────────────────────────────────────────────

test("cashfree doorstep QR stays off until the S2S flag is explicitly enabled", () => {
  const creds = { CASHFREE_CLIENT_ID: "id", CASHFREE_CLIENT_SECRET: "secret" };
  withEnv({ ...creds, PAYMENT_PROVIDER: "cashfree", CASHFREE_S2S_ENABLED: undefined }, () => {
    assert.equal(gateway.isConfigured(), true, "checkout works");
    assert.equal(gateway.qrConfigured(), false, "but doorstep QR does not");
  });
  withEnv({ ...creds, PAYMENT_PROVIDER: "cashfree", CASHFREE_S2S_ENABLED: "true" }, () => {
    assert.equal(gateway.qrConfigured(), true);
  });
});

test("a blank or non-true S2S value does not switch doorstep QR on", () => {
  const creds = { CASHFREE_CLIENT_ID: "id", CASHFREE_CLIENT_SECRET: "secret" };
  for (const value of ["", "false", "0", "yes", "TRUE "]) {
    withEnv({ ...creds, PAYMENT_PROVIDER: "cashfree", CASHFREE_S2S_ENABLED: value }, () => {
      // Note "TRUE " — the trailing space means it is not the literal "true".
      assert.equal(gateway.qrConfigured(), false, `"${value}" must not enable QR`);
    });
  }
});

test("credentials alone are not enough for cashfree doorstep QR", () => {
  withEnv(
    {
      PAYMENT_PROVIDER: "cashfree",
      CASHFREE_CLIENT_ID: undefined,
      CASHFREE_CLIENT_SECRET: undefined,
      CASHFREE_S2S_ENABLED: "true",
    },
    () => {
      assert.equal(gateway.qrConfigured(), false, "no credentials means no QR");
    }
  );
});

test("phonepe doorstep QR still depends on its own separate DQR credentials", () => {
  withEnv(
    {
      PAYMENT_PROVIDER: "phonepe",
      PHONEPE_CLIENT_ID: "id",
      PHONEPE_CLIENT_SECRET: "secret",
      PHONEPE_DQR_SALT_KEY: undefined,
      PHONEPE_DQR_STORE_ID: undefined,
    },
    () => {
      assert.equal(gateway.isConfigured(), true, "checkout works");
      assert.equal(gateway.qrConfigured(), false, "offline product is a separate onboarding");
    }
  );
});

// ── phonepe callback parsing, via the adapter ──────────────────────────────

test("the phonepe adapter accepts every spelling the v2 webhook has used", () => {
  withEnv({ PAYMENT_PROVIDER: "phonepe" }, () => {
    const shapes = [
      { payload: { merchantOrderId: "MFB1", state: "COMPLETED" } },
      { payload: { merchantTransactionId: "MFB1", state: "COMPLETED" } },
      { data: { merchantOrderId: "MFB1", status: "COMPLETED" } },
      { merchantOrderId: "MFB1", state: "COMPLETED" },
      { merchantTransactionId: "MFB1", state: "COMPLETED" },
    ];
    for (const body of shapes) {
      const parsed = gateway.parseCallback({ body });
      assert.equal(parsed?.merchantOrderId, "MFB1", JSON.stringify(body));
    }
  });
});

test("an unparseable phonepe body returns null rather than throwing", () => {
  withEnv({ PAYMENT_PROVIDER: "phonepe" }, () => {
    assert.equal(gateway.parseCallback({ body: { nothing: true } }), null);
    assert.equal(gateway.parseCallback({}), null);
  });
});

// ── config reporting ───────────────────────────────────────────────────────

test("config() reports env and sdk for both providers", () => {
  withEnv({ PAYMENT_PROVIDER: "cashfree", CASHFREE_ENV: "PROD" }, () => {
    const c = gateway.config();
    assert.equal(c.env, "PROD");
    assert.equal(c.sdk, "PRODUCTION");
  });
  withEnv({ PAYMENT_PROVIDER: "phonepe", PHONEPE_ENV: "UAT" }, () => {
    const c = gateway.config();
    assert.equal(c.env, "UAT");
    assert.equal(c.sdk, "SANDBOX");
  });
});
