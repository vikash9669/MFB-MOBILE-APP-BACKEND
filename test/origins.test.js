const test = require("node:test");
const assert = require("node:assert");

const load = () => {
  delete require.cache[require.resolve("../util/origins")];
  return require("../util/origins");
};

const withEnv = (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try { return fn(load()); } finally { process.env = saved; }
};

test("an allowed origin is used verbatim", () => {
  withEnv({ ADMIN_PANEL_ORIGINS: "https://shop.test,https://panel.test" }, (o) => {
    assert.strictEqual(o.webBase({ headers: { origin: "https://shop.test" } }), "https://shop.test");
    assert.strictEqual(o.webBase({ headers: { origin: "https://panel.test" } }), "https://panel.test");
  });
});

// The whole reason the Origin is checked rather than trusted.
test("a forged origin never becomes the redirect target", () => {
  withEnv({ ADMIN_PANEL_ORIGINS: "https://shop.test", STOREFRONT_URL: "https://configured.test" }, (o) => {
    const base = o.webBase({ headers: { origin: "https://evil.test" } });
    assert.strictEqual(base, "https://configured.test");
    assert.ok(!base.includes("evil"));
  });
});

test("no request falls back to configuration", () => {
  withEnv({ ADMIN_PANEL_ORIGINS: "https://shop.test", STOREFRONT_URL: "https://configured.test" }, (o) => {
    assert.strictEqual(o.webBase(null), "https://configured.test");
  });
});

// The production failure this replaced: unset config meant a localhost literal.
test("with no configuration at all it uses the allowlist, not localhost", () => {
  withEnv({ ADMIN_PANEL_ORIGINS: "https://shop.test", STOREFRONT_URL: undefined, PANEL_URL: undefined }, (o) => {
    assert.strictEqual(o.webBase(null), "https://shop.test");
  });
});

test("trailing slashes are normalised on both sides", () => {
  withEnv({ ADMIN_PANEL_ORIGINS: "https://shop.test/" }, (o) => {
    assert.ok(o.allows("https://shop.test"));
    assert.ok(o.allows("https://shop.test///"));
    assert.strictEqual(o.webBase({ headers: { origin: "https://shop.test/" } }), "https://shop.test");
  });
});

test("a missing origin is not allowed", () => {
  withEnv({ ADMIN_PANEL_ORIGINS: "https://shop.test" }, (o) => {
    assert.ok(!o.allows(undefined));
    assert.ok(!o.allows(""));
    assert.ok(!o.allows(null));
  });
});
