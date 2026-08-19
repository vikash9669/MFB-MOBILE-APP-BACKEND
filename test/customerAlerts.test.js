const test = require("node:test");
const assert = require("node:assert");

// The delivery OTP going out over SMS/WhatsApp. The interesting cases are all
// the ones where it must NOT send, because the failure mode of getting those
// wrong is texting real customers from a staging box.

const load = () => {
  delete require.cache[require.resolve("../util/customerAlerts")];
  return require("../util/customerAlerts");
};

const BASE = {
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_WHATSAPP_FROM: "+14155238886",
  TWILIO_SMS_FROM: "+14155238887",
  CUSTOMER_ALERT_CHANNELS: undefined,
  CUSTOMER_ALERT_DRY_RUN: undefined,
  // Keep the delivery-confirmation wait short. In production notify() waits a
  // few seconds for Twilio to move the message off "queued" before it believes
  // the send worked; tests do not need to sit through that.
  CUSTOMER_ALERT_CONFIRM_MS: "60",
  TWILIO_WA_OTP_CONTENT_SID: undefined,
};

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

// A message Twilio reports as delivered. notify() polls for this after every
// accepted send, because a 201 only means "accepted" — both real WhatsApp
// failures seen in practice (63015, 63016) arrived seconds later.
const delivered = (sid = "SM1") => ({
  ok: true,
  status: 200,
  json: async () => ({ sid, status: "delivered" }),
});

/**
 * Swaps global fetch for a recorder, so nothing leaves the process.
 *
 * Only the POSTs that actually send a message are recorded; the status GETs
 * notify() makes afterwards answer "delivered" and are not counted, so the
 * assertions below stay about sends rather than about HTTP traffic.
 */
const withFetch = async (impl, fn) => {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const isSend = String(url).endsWith("/Messages.json") && init?.method === "POST";
    if (!isSend) return delivered();
    calls.push({ url, body: new URLSearchParams(init.body) });
    return impl(calls.length);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = real;
  }
};

const ok = () => ({ ok: true, status: 201, json: async () => ({ sid: "SM1", status: "queued" }) });
const fail = () => ({ ok: false, status: 400, json: async () => ({ message: "not a whatsapp user" }) });

test("sends over WhatsApp first and does not also send SMS", async () => {
  const alerts = load();
  await withEnv(BASE, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 42, otp: "123456" });
      assert.equal(r.sent, true);
      assert.equal(r.channel, "whatsapp");
      // A customer who gets the same code twice learns to ignore one of them.
      assert.equal(calls.length, 1, "must stop at the first success");
      assert.match(calls[0].body.get("To"), /^whatsapp:\+919876543210$/);
    })
  );
});

test("falls back to SMS when WhatsApp is rejected", async () => {
  const alerts = load();
  await withEnv(BASE, () =>
    withFetch((n) => (n === 1 ? fail() : ok()), async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 42, otp: "123456" });
      assert.equal(r.sent, true);
      assert.equal(r.channel, "sms");
      assert.equal(calls.length, 2);
      assert.equal(calls[1].body.get("To"), "+919876543210");
    })
  );
});

test("the message carries the code and warns against sharing it on a call", async () => {
  const alerts = load();
  await withEnv(BASE, () =>
    withFetch(ok, async (calls) => {
      await alerts.sendDeliveryOtp({
        phone: "9876543210",
        orderId: 272393,
        otp: "817412",
        riderName: "Ramesh",
      });
      const body = calls[0].body.get("Body");
      assert.match(body, /817412/);
      assert.match(body, /272393/);
      assert.match(body, /Ramesh/);
      // Delivery codes are a standing target for social engineering.
      assert.match(body, /never ask for this code/i);
    })
  );
});

test("dry run sends nothing at all", async () => {
  const alerts = load();
  await withEnv({ ...BASE, CUSTOMER_ALERT_DRY_RUN: "true" }, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, false);
      assert.equal(r.dryRun, true);
      assert.equal(calls.length, 0, "a staging box must not text real customers");
    })
  );
});

test("no Twilio credentials means no send and no throw", async () => {
  const alerts = load();
  await withEnv({ ...BASE, TWILIO_ACCOUNT_SID: undefined }, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, false);
      assert.equal(calls.length, 0);
    })
  );
});

test("a short or missing phone number is refused before any HTTP call", async () => {
  const alerts = load();
  await withEnv(BASE, () =>
    withFetch(ok, async (calls) => {
      for (const phone of [null, "", "12345"]) {
        const r = await alerts.sendDeliveryOtp({ phone, orderId: 1, otp: "111111" });
        assert.equal(r.sent, false, `phone=${phone}`);
      }
      assert.equal(calls.length, 0);
    })
  );
});

test("a missing OTP is never sent as an empty message", async () => {
  const alerts = load();
  await withEnv(BASE, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: null });
      assert.equal(r.sent, false);
      assert.equal(calls.length, 0);
    })
  );
});

test("CUSTOMER_ALERT_CHANNELS narrows the channels, and empty disables entirely", async () => {
  const alerts = load();

  await withEnv({ ...BASE, CUSTOMER_ALERT_CHANNELS: "sms" }, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.channel, "sms");
      assert.equal(calls[0].body.get("To"), "+919876543210", "no whatsapp: prefix");
    })
  );

  await withEnv({ ...BASE, CUSTOMER_ALERT_CHANNELS: "" }, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, false);
      assert.equal(calls.length, 0);
    })
  );
});

test("a channel with no from-number is skipped rather than failing the send", async () => {
  const alerts = load();
  await withEnv({ ...BASE, TWILIO_WHATSAPP_FROM: undefined }, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, true);
      assert.equal(r.channel, "sms");
      assert.equal(calls.length, 1);
    })
  );
});

test("a thrown network error is contained, not propagated", async () => {
  const alerts = load();
  // Nothing here may fail a delivery that has already been accepted.
  await withEnv(BASE, async () => {
    const real = global.fetch;
    global.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    try {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, false);
      assert.match(r.reason, /ECONNRESET/);
    } finally {
      global.fetch = real;
    }
  });
});

test("WhatsApp goes out as a template when one is configured, SMS stays plain text", async () => {
  const alerts = load();
  await withEnv({ ...BASE, TWILIO_WA_OTP_CONTENT_SID: "HXtest123" }, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({
        phone: "9876543210",
        orderId: 272401,
        otp: "817412",
        riderName: "Ramesh",
      });
      assert.equal(r.sent, true);
      assert.equal(r.templated, true);

      // A business-initiated free-form WhatsApp is refused with 63016, so the
      // body must travel as template variables rather than as Body.
      assert.equal(calls[0].body.get("ContentSid"), "HXtest123");
      assert.equal(calls[0].body.get("Body"), null);

      const vars = JSON.parse(calls[0].body.get("ContentVariables"));
      assert.deepEqual(vars, { 1: "Ramesh", 2: "272401", 3: "817412" });
    })
  );

  // Without a template sid the WhatsApp leg still sends free-form, so the file
  // keeps working before approval comes through.
  await withEnv(BASE, () =>
    withFetch(ok, async (calls) => {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.templated, false);
      assert.match(calls[0].body.get("Body"), /111111/);
    })
  );
});

test("a send that Twilio accepts and then fails still falls through to SMS", async () => {
  // THE REGRESSION THIS EXISTS FOR: the API returns 201 "queued" and the real
  // failure (63016 no-template, 63015 not-in-sandbox) lands seconds later. The
  // old code read 201 as success and stopped, so SMS never fired and the
  // customer silently got nothing.
  const alerts = load();
  await withEnv(BASE, async () => {
    const real = global.fetch;
    const sends = [];
    global.fetch = async (url, init) => {
      if (String(url).endsWith("/Messages.json") && init?.method === "POST") {
        const to = new URLSearchParams(init.body).get("To");
        sends.push(to);
        return { ok: true, status: 201, json: async () => ({ sid: to.startsWith("whatsapp:") ? "SMwa" : "SMsms", status: "queued" }) };
      }
      // The WhatsApp one dies after the fact; the SMS one goes through.
      const dead = String(url).includes("SMwa");
      return {
        ok: true,
        status: 200,
        json: async () => (dead
          ? { sid: "SMwa", status: "undelivered", error_code: 63016, error_message: "no template" }
          : { sid: "SMsms", status: "delivered" }),
      };
    };
    try {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, true);
      assert.equal(r.channel, "sms", "must not stop at a WhatsApp that died after acceptance");
      assert.equal(sends.length, 2);
      assert.ok(sends[0].startsWith("whatsapp:"));
      assert.equal(sends[1], "+919876543210");
    } finally {
      global.fetch = real;
    }
  });
});

test("a message still queued at the deadline counts as sent, not as a failure", async () => {
  // Twilio is often just slow. Re-sending down a second channel because a
  // message had not settled yet would double-text customers routinely.
  const alerts = load();
  await withEnv(BASE, async () => {
    const real = global.fetch;
    let sends = 0;
    global.fetch = async (url, init) => {
      if (String(url).endsWith("/Messages.json") && init?.method === "POST") {
        sends += 1;
        return { ok: true, status: 201, json: async () => ({ sid: "SM1", status: "queued" }) };
      }
      return { ok: true, status: 200, json: async () => ({ sid: "SM1", status: "queued" }) };
    };
    try {
      const r = await alerts.sendDeliveryOtp({ phone: "9876543210", orderId: 1, otp: "111111" });
      assert.equal(r.sent, true);
      assert.equal(r.confirmed, false, "reported as unconfirmed rather than as delivered");
      assert.equal(sends, 1, "must not also send SMS");
    } finally {
      global.fetch = real;
    }
  });
});
