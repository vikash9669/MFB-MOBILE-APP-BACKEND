const test = require("node:test");
const assert = require("node:assert");

// Mail transports.
//
// Two ways out, because the host decides which one works: SMTP is
// provider-agnostic and right on a VPS, the HTTPS API is the only one that
// works where outbound SMTP ports are blocked (Render's free tier blocks 25,
// 465 and 587). EMAIL_TRANSPORT picks. Getting that selection wrong means mail
// that silently never arrives, so it is worth pinning.

const load = () => {
  delete require.cache[require.resolve("../util/email")];
  return require("../util/email");
};

const withEnv = async (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(load()); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const SG = { EMAIL_PASS: "SG.fake-key", EMAIL_HOST: "smtp.sendgrid.net", EMAIL_FROM: "o@x.com" };

test("auto prefers the API when a SendGrid key is present", async () => {
  await withEnv({ ...SG, EMAIL_TRANSPORT: "auto" }, (m) => {
    assert.equal(m.transportName(), "api");
  });
});

test("auto falls back to SMTP for a non-SendGrid provider", async () => {
  // A Gmail or Hostinger password is not a SendGrid key, and must not be
  // mistaken for one — that would send every mail to the wrong provider.
  await withEnv(
    { EMAIL_TRANSPORT: "auto", EMAIL_PASS: "an-ordinary-password", EMAIL_HOST: "smtp.gmail.com", EMAIL_FROM: "o@x.com" },
    (m) => assert.equal(m.transportName(), "smtp")
  );
});

test("the toggle is obeyed in both directions", async () => {
  await withEnv({ ...SG, EMAIL_TRANSPORT: "smtp" }, (m) =>
    assert.equal(m.transportName(), "smtp", "explicit smtp must win even with a SendGrid key"));
  await withEnv({ ...SG, EMAIL_TRANSPORT: "api" }, (m) =>
    assert.equal(m.transportName(), "api"));
});

test("forcing a transport that is not configured reports unconfigured", async () => {
  // Better to say "not configured" at boot than to fall back silently to a
  // transport the host will block.
  await withEnv(
    { EMAIL_TRANSPORT: "api", EMAIL_PASS: "not-a-sendgrid-key", EMAIL_HOST: "smtp.gmail.com", EMAIL_FROM: "o@x.com" },
    (m) => {
      assert.equal(m.transportName(), null);
      assert.equal(m.mailConfigured(), false);
    }
  );
});

test("SENDGRID_API_KEY wins over EMAIL_PASS", async () => {
  await withEnv({ ...SG, SENDGRID_API_KEY: "SG.explicit", EMAIL_TRANSPORT: "api" }, (m) =>
    assert.equal(m.transportName(), "api"));
});

test("comma-joined recipients are split for the API", async () => {
  // SMTP accepts "a@x, b@y" verbatim; the API needs one object each. Admin
  // alerts are sent as a single message to everyone, so this is the normal case.
  const m = load();
  assert.deepEqual(m.recipientList("a@x.com, b@y.com ,c@z.com"), ["a@x.com", "b@y.com", "c@z.com"]);
  assert.deepEqual(m.recipientList(""), []);
  assert.deepEqual(m.recipientList(null), []);
});

test("the API payload is shaped the way SendGrid expects", async () => {
  const real = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return { status: 202, headers: { get: () => "msg-1" } };
  };
  try {
    await withEnv({ ...SG, EMAIL_TRANSPORT: "api" }, async (m) => {
      const r = await m.sendMail({ to: "a@x.com, b@y.com", subject: "S", html: "<p>H</p>" });
      assert.equal(r.sent, true);
      assert.equal(r.transport, "api");
    });
    assert.match(captured.url, /api\.sendgrid\.com\/v3\/mail\/send/);
    assert.equal(captured.auth, "Bearer SG.fake-key");
    assert.deepEqual(captured.body.personalizations[0].to, [{ email: "a@x.com" }, { email: "b@y.com" }]);
    assert.equal(captured.body.from.email, "o@x.com");
    assert.equal(captured.body.content[0].type, "text/html");
  } finally { global.fetch = real; }
});

test("an API error surfaces SendGrid's reason, not a bare status", async () => {
  // The reason the API path is nicer to operate: SMTP gives "550 rejected";
  // this names the field.
  const real = global.fetch;
  global.fetch = async () => ({
    status: 403,
    json: async () => ({ errors: [{ field: "from.email", message: "does not match a verified Sender Identity" }] }),
  });
  try {
    await withEnv({ ...SG, EMAIL_TRANSPORT: "api" }, async (m) => {
      const r = await m.sendMail({ to: "a@x.com", subject: "S", html: "H" });
      assert.equal(r.sent, false);
      assert.match(r.reason, /from\.email/);
      assert.match(r.reason, /verified Sender Identity/);
    });
  } finally { global.fetch = real; }
});

test("sendMail never throws, whatever the transport does", async () => {
  const real = global.fetch;
  global.fetch = async () => { throw new Error("socket hang up"); };
  try {
    await withEnv({ ...SG, EMAIL_TRANSPORT: "api" }, async (m) => {
      const r = await m.sendMail({ to: "a@x.com", subject: "S", html: "H" });
      assert.equal(r.sent, false);
      assert.match(r.reason, /socket hang up/);
    });
  } finally { global.fetch = real; }
});

test("no address means no send attempt at all", async () => {
  await withEnv({ ...SG, EMAIL_TRANSPORT: "api" }, async (m) => {
    const r = await m.sendMail({ to: "", subject: "S", html: "H" });
    assert.equal(r.sent, false);
    assert.match(r.reason, /no address/);
  });
});
