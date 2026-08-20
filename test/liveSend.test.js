const test = require("node:test");
const assert = require("node:assert");

// The live-send allowlist.
//
// This is the only thing standing between a test order placed on a laptop and a
// real restaurant's phone ringing, because the backend runs against a clone of
// the production database. Its correctness is not a nicety: a false "allowed"
// contacts a stranger, and a false "blocked" in production silences the
// platform.

const load = () => {
  delete require.cache[require.resolve("../util/liveSend")];
  return require("../util/liveSend");
};

const withEnv = (value, fn) => {
  const prev = process.env.LIVE_SEND_ALLOWLIST;
  if (value === undefined) delete process.env.LIVE_SEND_ALLOWLIST;
  else process.env.LIVE_SEND_ALLOWLIST = value;
  try {
    fn(load());
  } finally {
    if (prev === undefined) delete process.env.LIVE_SEND_ALLOWLIST;
    else process.env.LIVE_SEND_ALLOWLIST = prev;
  }
};

test("unset means no restriction — production must work unconfigured", () => {
  // The inverse default would mean a deploy that forgets this variable delivers
  // nothing, which is precisely the dry-run failure this replaced.
  withEnv(undefined, (l) => {
    assert.equal(l.unrestricted(), true);
    assert.equal(l.allows("9876543210"), true);
    assert.equal(l.allows("anyone@example.com"), true);
    assert.equal(l.blocked("9876543210", "sms"), null, "nothing may be refused when unset");
  });
});

test('"*" is an explicit way to say the same thing', () => {
  withEnv("*", (l) => {
    assert.equal(l.unrestricted(), true);
    assert.equal(l.allows("9876543210"), true);
  });
});

test("a configured list admits only its members", () => {
  withEnv("9669901922,orders@myfirstbite.in", (l) => {
    assert.equal(l.unrestricted(), false);
    assert.equal(l.allows("9669901922"), true);
    assert.equal(l.allows("orders@myfirstbite.in"), true);
    assert.equal(l.allows("9876543210"), false);
    assert.equal(l.allows("stranger@example.com"), false);
  });
});

test("phone formatting cannot smuggle a number past the list", () => {
  // The app stores numbers several ways; all of them are the same handset.
  withEnv("9669901922", (l) => {
    for (const v of ["9669901922", "+919669901922", "919669901922", "+91 96699 01922", "09669901922"]) {
      assert.equal(l.allows(v), true, `${v} should match the allowlisted number`);
    }
  });
});

test("an allowlisted number does not admit a lookalike", () => {
  withEnv("9669901922", (l) => {
    // Differs only in the last digit — the bug a naive "endsWith" would have.
    assert.equal(l.allows("9669901923"), false);
    assert.equal(l.allows("966990192"), false, "9 digits is not a match");
  });
});

test("email comparison ignores case and padding", () => {
  withEnv(" Orders@MyFirstBite.IN ", (l) => {
    assert.equal(l.allows("orders@myfirstbite.in"), true);
    assert.equal(l.allows("ORDERS@MYFIRSTBITE.IN"), true);
  });
});

test("blocked() returns a result callers already know how to handle", () => {
  withEnv("9669901922", (l) => {
    const r = l.blocked("9876543210", "vendor sms");
    assert.equal(r.sent, false);
    assert.equal(r.blocked, true);
    assert.match(r.reason, /LIVE_SEND_ALLOWLIST/);
    // Allowed recipients get null, meaning "carry on".
    assert.equal(l.blocked("9669901922", "vendor sms"), null);
  });
});

test("an empty or junk recipient is never allowed under a live list", () => {
  withEnv("9669901922", (l) => {
    for (const v of ["", null, undefined, "   ", "abc"]) {
      assert.equal(l.allows(v), false, `${JSON.stringify(v)} must not pass`);
    }
  });
});

test("masking shows enough to recognise your own number and no more", () => {
  const l = load();
  assert.equal(l.mask("+919669901922"), "***1922");
  assert.equal(l.mask("orders@myfirstbite.in"), "or***@myfirstbite.in");
});

test("changing the list at runtime takes effect", () => {
  // The parsed form is memoised; the memo must key on the raw value, or a
  // deploy that edits the list keeps honouring the old one until restart.
  withEnv("9669901922", (l) => assert.equal(l.allows("9876543210"), false));
  withEnv("9876543210", (l) => assert.equal(l.allows("9876543210"), true));
});
