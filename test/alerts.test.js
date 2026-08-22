const test = require("node:test");
const assert = require("node:assert");

const { isRealAddress } = require("../util/email");
const adminNotify = require("../util/adminNotify");
const riderAlerts = require("../util/riderAlerts");

// Channel gating and recipient resolution. These are the two decisions that
// decide whether a real person's phone rings and how much it costs, so they are
// tested without a database, an SMTP host or a Twilio account behind them.

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

// ── Admin alert channels ───────────────────────────────────────────

test("admin alerts default to panel only — email and SMS are opt-in", () => {
  // The default has to be the cheap, local one. Email and SMS cost money and
  // reach real people, and a default that sends them means a fresh deploy
  // starts texting whoever is in ADMIN_ALERT_PHONES.
  withEnv({ RIDER_ALERT_CHANNELS: undefined }, () => {
    const c = adminNotify._enabledChannels();
    assert.ok(c.has("panel"));
    assert.ok(!c.has("email"), "email must not be on by default");
    assert.ok(!c.has("sms"), "sms must not be on by default");
  });
});

test("an empty RIDER_ALERT_CHANNELS is the default, not silence", () => {
  // An env var set to "" is what a dashboard gives you when someone clears the
  // field. Treating it as "no channels at all" would silently switch off the
  // durable panel notification, which is the one that must never be lost.
  withEnv({ RIDER_ALERT_CHANNELS: "" }, () => {
    assert.ok(adminNotify._enabledChannels().has("panel"));
  });
});

test("panel implies realtime — they are the same news", () => {
  withEnv({ RIDER_ALERT_CHANNELS: "panel" }, () => {
    assert.ok(adminNotify._enabledChannels().has("realtime"));
  });
});

test("channels are parsed case- and space-insensitively", () => {
  withEnv({ RIDER_ALERT_CHANNELS: " Panel , EMAIL ,sms " }, () => {
    const c = adminNotify._enabledChannels();
    assert.deepStrictEqual([...c].sort(), ["email", "panel", "realtime", "sms"]);
  });
});

test("turning everything off is possible and does not fall back to a default", () => {
  withEnv({ RIDER_ALERT_CHANNELS: "none" }, () => {
    const c = adminNotify._enabledChannels();
    assert.ok(!c.has("panel"));
    assert.ok(!c.has("email"));
    assert.ok(!c.has("sms"));
  });
});

// ── Who gets the mail ──────────────────────────────────────────────

const admins = [
  { user_id: 1, user_email: "ops@myfirstbite.in" },
  { user_id: 2, user_email: "manager@myfirstbite.in" },
  { user_id: 3, user_email: "" },
  { user_id: 4, user_email: "dp9999999999@example.com" },
];

test("RIDER_ALERT_EMAILS narrows the recipients to the people who review", () => {
  withEnv({ RIDER_ALERT_EMAILS: "reviewer@myfirstbite.in" }, () => {
    assert.deepStrictEqual(adminNotify._mailRecipients(admins), ["reviewer@myfirstbite.in"]);
  });
});

test("without it, every admin with a real address gets one", () => {
  withEnv({ RIDER_ALERT_EMAILS: undefined }, () => {
    assert.deepStrictEqual(adminNotify._mailRecipients(admins), [
      "ops@myfirstbite.in",
      "manager@myfirstbite.in",
    ]);
  });
});

test("blank and placeholder addresses are dropped, not mailed", () => {
  withEnv({ RIDER_ALERT_EMAILS: undefined }, () => {
    const to = adminNotify._mailRecipients(admins);
    assert.ok(!to.includes(""));
    assert.ok(!to.some((e) => e.endsWith("@example.com")));
  });
});

// ── Placeholder addresses ──────────────────────────────────────────

test("the generated rider placeholder is never a real address", () => {
  // models/delivery_partner.js fills dp_email with dp<phone>@example.com for a
  // rider who never typed one. Most riders never do — the onboarding checklist
  // does not require it — so without this guard nearly every "you're approved"
  // mail would bounce.
  assert.strictEqual(isRealAddress("dp9876543210@example.com"), false);
  assert.strictEqual(isRealAddress("someone@example.org"), false);
  assert.strictEqual(isRealAddress("ravi@gmail.com"), true);
});

test("isRealAddress refuses junk rather than throwing", () => {
  for (const junk of [null, undefined, "", "   ", "not-an-email", "@example.com", "a@"]) {
    assert.strictEqual(isRealAddress(junk), false, `accepted ${JSON.stringify(junk)}`);
  }
});

test("a subdomain of example.com is not treated as the placeholder", () => {
  // Exact-domain match, not endsWith: "mail.example.com.co" would slip past a
  // suffix test, and a real company domain must not be silently dropped.
  assert.strictEqual(isRealAddress("a@notexample.com"), true);
});

// ── Rider decision channels ────────────────────────────────────────

test("rider decisions default to BOTH email and SMS", () => {
  // Opposite default to the admin alerts, on purpose: the rider is the person
  // waiting on this answer, and neither channel can reach anyone who did not
  // apply, so there is no fan-out cost to guard against.
  withEnv({ RIDER_DECISION_CHANNELS: undefined }, () => {
    const c = riderAlerts._enabledChannels();
    assert.ok(c.has("email"));
    assert.ok(c.has("sms"));
  });
});

test("rider decision channels can be narrowed to one", () => {
  withEnv({ RIDER_DECISION_CHANNELS: "sms" }, () => {
    const c = riderAlerts._enabledChannels();
    assert.ok(c.has("sms"));
    assert.ok(!c.has("email"));
  });
});

// ── The contract that matters: these must never throw ──────────────
//
// Both are called as a side effect of something already written to the
// database — an application submitted, a rider approved. If either could
// throw, a dead SMTP host or a suspended SMS account would turn a successful
// approval into a 500, and the caller would have no way to tell that the thing
// it was asked to do had in fact succeeded.

test("admin notify with every channel off touches nothing and returns", async () => {
  await withEnv({ RIDER_ALERT_CHANNELS: "none" }, async () => {
    const result = await adminNotify.notifyAdminsRiderApplied({
      dp_id: 1,
      dp_name: "Test",
      dp_phone: "9999999999",
    });
    assert.strictEqual(result.panel, 0);
    assert.strictEqual(result.realtime, 0);
    assert.strictEqual(result.email, null);
    assert.strictEqual(result.sms, null);
    assert.ok(!result.error, `unexpected error: ${result.error}`);
  });
});

test("rider decision with every channel off returns cleanly", async () => {
  await withEnv({ RIDER_DECISION_CHANNELS: "none" }, async () => {
    const result = await riderAlerts.alertRiderDecision(
      { dp_name: "Ravi", dp_email: "ravi@gmail.com", dp_phone: "9876543210" },
      { approved: true }
    );
    assert.strictEqual(result.email, null);
    assert.strictEqual(result.sms, null);
  });
});

test("rider decision reports a reason per channel rather than sending blind", async () => {
  // With no SMTP and no Twilio configured — which is the state of this test
  // process, and of production for SMS today — both channels must come back
  // with a reason, not a thrown error and not a silent success.
  await withEnv(
    {
      RIDER_DECISION_CHANNELS: "email,sms",
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      EMAIL_HOST: undefined,
      EMAIL_PASS: undefined,
      SENDGRID_API_KEY: undefined,
    },
    async () => {
      const result = await riderAlerts.alertRiderDecision(
        { dp_name: "Ravi", dp_email: "ravi@gmail.com", dp_phone: "9876543210" },
        { approved: true }
      );
      assert.strictEqual(result.email.sent, false);
      assert.ok(result.email.reason, "no reason given for the unsent email");
      assert.strictEqual(result.sms.sent, false);
      assert.ok(result.sms.reason, "no reason given for the unsent SMS");
    }
  );
});

test("a rider with a placeholder address is skipped, not attempted", async () => {
  await withEnv({ RIDER_DECISION_CHANNELS: "email" }, async () => {
    const result = await riderAlerts.alertRiderDecision(
      { dp_name: "Ravi", dp_email: "dp9876543210@example.com", dp_phone: "9876543210" },
      { approved: true }
    );
    assert.strictEqual(result.email.sent, false);
    assert.match(result.email.reason, /placeholder|no real address/i);
  });
});

test("a partner object full of nulls does not throw", async () => {
  // Defensive, but the shape comes from the database and dp_name is nullable.
  await withEnv({ RIDER_DECISION_CHANNELS: "email,sms" }, async () => {
    const result = await riderAlerts.alertRiderDecision(
      { dp_name: null, dp_email: null, dp_phone: null },
      { approved: false, reason: null }
    );
    assert.ok(result.email);
    assert.ok(result.sms);
    assert.ok(!result.error, `threw internally: ${result.error}`);
  });
});

// ── Order escalation channels ──────────────────────────────────────

test("order escalations default to the panel, not email or SMS", async () => {
  await withEnv({ ORDER_ESCALATION_CHANNELS: undefined }, () => {
    const c = adminNotify._escalationChannels();
    assert.ok(c.has("panel"));
    assert.ok(c.has("realtime"), "panel must imply the live event");
    assert.ok(!c.has("email"));
    assert.ok(!c.has("sms"));
  });
});

test("the old email + SMS escalation can be switched back on", async () => {
  // Gated rather than deleted: a busy period should be an env change, not a
  // deploy.
  await withEnv({ ORDER_ESCALATION_CHANNELS: "panel,email,sms" }, () => {
    const c = adminNotify._escalationChannels();
    assert.deepStrictEqual([...c].sort(), ["email", "panel", "realtime", "sms"]);
  });
});

test("escalation mail uses ORDER_ALERT_EMAILS, not the rider list", async () => {
  // Two different audiences resolved by the same helper — crossing them would
  // send rider-application mail to the order desk and vice versa.
  await withEnv(
    { ORDER_ALERT_EMAILS: "orders@myfirstbite.in", RIDER_ALERT_EMAILS: "riders@myfirstbite.in" },
    () => {
      assert.deepStrictEqual(adminNotify._mailRecipients([], "ORDER_ALERT_EMAILS"), [
        "orders@myfirstbite.in",
      ]);
      assert.deepStrictEqual(adminNotify._mailRecipients([], "RIDER_ALERT_EMAILS"), [
        "riders@myfirstbite.in",
      ]);
    }
  );
});

test("order escalations never throw, whatever the transports do", async () => {
  await withEnv({ ORDER_ESCALATION_CHANNELS: "none" }, async () => {
    const stuck = await adminNotify.notifyAdminsOrderStuck({
      orderId: 1, shop: "Test Kitchen", minutesWaiting: 7, minutesUntilCancel: 3,
    });
    const cancelled = await adminNotify.notifyAdminsOrderCancelled({
      orderId: 1, shop: "Test Kitchen", refunded: false, amount: 250,
    });
    for (const r of [stuck, cancelled]) {
      assert.ok(!r.error, `threw internally: ${r.error}`);
      assert.strictEqual(r.panel, 0);
      assert.strictEqual(r.realtime, 0);
    }
  });
});

// ── The blank-vs-"none" trap ───────────────────────────────────────
//
// These two look interchangeable and are not. A blank value means "unset, use
// the default" — deliberately, so a field someone clears in a hosting dashboard
// cannot silently switch off the durable panel notification. "none" is the way
// to disable. Setting RIDER_DECISION_CHANNELS="" to turn rider messages off
// would have kept sending both email and SMS.

test("a blank channel list means the default, not silence", async () => {
  await withEnv({ RIDER_DECISION_CHANNELS: "" }, () => {
    const c = riderAlerts._enabledChannels();
    assert.ok(c.has("email") && c.has("sms"), "blank should fall back to the default");
  });
  await withEnv({ ORDER_ESCALATION_CHANNELS: "" }, () => {
    assert.ok(adminNotify._escalationChannels().has("panel"));
  });
});

test('"none" is what actually disables a channel list', async () => {
  await withEnv({ RIDER_DECISION_CHANNELS: "none" }, () => {
    const c = riderAlerts._enabledChannels();
    assert.ok(!c.has("email"), "email still enabled");
    assert.ok(!c.has("sms"), "sms still enabled");
  });
  await withEnv({ ORDER_ESCALATION_CHANNELS: "none" }, () => {
    const c = adminNotify._escalationChannels();
    assert.ok(!c.has("panel") && !c.has("email") && !c.has("sms"));
  });
});

test("the values shipped in render.yaml produce the intended routing", async () => {
  // Pins the deployed configuration itself, not just the parser. If someone
  // edits render.yaml to a value that does not mean what they think, this fails
  // rather than a vendor quietly getting texted again.
  await withEnv(
    {
      RIDER_ALERT_CHANNELS: "panel",
      ORDER_ESCALATION_CHANNELS: "panel",
      RIDER_DECISION_CHANNELS: "none",
    },
    () => {
      const admin = adminNotify._enabledChannels();
      assert.ok(admin.has("panel") && admin.has("realtime"));
      assert.ok(!admin.has("email") && !admin.has("sms"));

      const esc = adminNotify._escalationChannels();
      assert.ok(esc.has("panel") && esc.has("realtime"));
      assert.ok(!esc.has("email") && !esc.has("sms"));

      const rider = riderAlerts._enabledChannels();
      assert.ok(!rider.has("email") && !rider.has("sms"));
    }
  );
});
