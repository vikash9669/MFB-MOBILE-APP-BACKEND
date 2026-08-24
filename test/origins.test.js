const test = require("node:test");
const assert = require("node:assert");

// Where a customer may be sent back to after paying, and which browsers may
// call this API. Both read the same allowlist, deliberately.
//
// The case that motivated most of this: STOREFRONT_URL and PANEL_URL each hold
// ONE origin, but they sit next to ADMIN_PANEL_ORIGINS, which holds a
// comma-separated list — and the list had been pasted into PANEL_URL. webBase
// then returned "https://a.example,http://localhost:5173" as if it were a
// single base, so every payment-return and doorstep-QR link built from it was
// not a URL at all. Nothing failed loudly; the links were simply dead.

const withEnv = (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const origins = require("../util/origins");
const CLEAR = {
  ADMIN_PANEL_ORIGINS: undefined,
  STOREFRONT_URL: undefined,
  PANEL_URL: undefined,
};

// ── the allowlist ──────────────────────────────────────────────────────────

test("origins are split, trimmed, and stripped of trailing slashes", () => {
  withEnv({ ...CLEAR, ADMIN_PANEL_ORIGINS: " https://a.example/ , https://b.example ,, " }, () => {
    assert.deepEqual(origins.list(), ["https://a.example", "https://b.example"]);
  });
});

test("an allowed origin matches with or without a trailing slash", () => {
  withEnv({ ...CLEAR, ADMIN_PANEL_ORIGINS: "https://a.example" }, () => {
    assert.equal(origins.allows("https://a.example"), true);
    assert.equal(origins.allows("https://a.example/"), true);
    assert.equal(origins.allows("https://evil.example"), false);
    assert.equal(origins.allows(""), false);
    assert.equal(origins.allows(undefined), false);
  });
});

// ── webBase ────────────────────────────────────────────────────────────────

test("a pasted comma-separated list yields ONE usable origin", () => {
  withEnv({ ...CLEAR, PANEL_URL: "https://a.example/,http://localhost:5173" }, () => {
    const base = origins.webBase(null);
    assert.equal(base, "https://a.example");
    assert.doesNotMatch(base, /,/, "a base containing a comma is not a URL");
    assert.equal(`${base}/payment/return?txn=X`, "https://a.example/payment/return?txn=X");
  });
});

test("STOREFRONT_URL wins over PANEL_URL", () => {
  withEnv({ ...CLEAR, STOREFRONT_URL: "https://shop.example", PANEL_URL: "https://panel.example" }, () => {
    assert.equal(origins.webBase(null), "https://shop.example");
  });
});

test("the origin the request actually came from is preferred, if allowed", () => {
  withEnv({ ...CLEAR, ADMIN_PANEL_ORIGINS: "https://a.example", STOREFRONT_URL: "https://stale.example" }, () => {
    const req = { headers: { origin: "https://a.example" } };
    assert.equal(origins.webBase(req), "https://a.example", "the customer is demonstrably there");
  });
});

test("a forged Origin header cannot redirect the customer off-site", () => {
  withEnv({ ...CLEAR, ADMIN_PANEL_ORIGINS: "https://a.example", STOREFRONT_URL: "https://a.example" }, () => {
    const req = { headers: { origin: "https://attacker.example" } };
    assert.equal(origins.webBase(req), "https://a.example", "must fall back to configuration");
  });
});

test("with nothing configured it falls back to the first allowlist entry", () => {
  withEnv({ ...CLEAR, ADMIN_PANEL_ORIGINS: "https://only.example" }, () => {
    assert.equal(origins.webBase(null), "https://only.example");
  });
});

test("firstOrigin is tolerant of junk and never returns a comma", () => {
  assert.equal(origins.firstOrigin("https://a.example/"), "https://a.example");
  assert.equal(origins.firstOrigin(" , https://b.example "), "https://b.example");
  assert.equal(origins.firstOrigin(""), "");
  assert.equal(origins.firstOrigin(undefined), "");
  assert.equal(origins.firstOrigin(",,,"), "");
});

// ── rejection logging ──────────────────────────────────────────────────────

test("a blocked origin is reported once, not on every request", () => {
  const seen = [];
  const orig = console.log;
  console.log = (...a) => seen.push(a.join(" "));
  try {
    origins.noteRejected("https://noisy.example");
    origins.noteRejected("https://noisy.example");
    origins.noteRejected("https://noisy.example");
  } finally { console.log = orig; }
  assert.equal(seen.length, 1, "a misconfigured front end must not flood the log");
  assert.match(seen[0], /ADMIN_PANEL_ORIGINS/, "the message must name the fix");
});
