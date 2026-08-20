const test = require("node:test");
const assert = require("node:assert");

// Health endpoints.
//
// The property that matters is the SEPARATION: liveness must not depend on the
// database. If it did, a brief database blip would look like a dead process and
// the platform would restart a healthy one — during exactly the incident when
// restarting is worst.

const load = () => {
  for (const m of ["../controllers/health", "../util/database", "../util/schema"]) {
    delete require.cache[require.resolve(m)];
  }
  return {
    health: require("../controllers/health"),
    sequelize: require("../util/database"),
  };
};

// Captures what a handler sent, without an HTTP server.
function fakeRes() {
  const res = { code: 200, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test("liveness answers without touching the database", async () => {
  const { health, sequelize } = load();
  let queried = false;
  sequelize.query = async () => { queried = true; return [[], {}]; };

  const res = fakeRes();
  await health.live({}, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(queried, false, "liveness must never query — that is its whole purpose");
  assert.ok(typeof res.body.uptime_seconds === "number");
});

test("readiness reports ok when the database answers", async () => {
  const { health, sequelize } = load();
  sequelize.query = async () => [[{ 1: 1 }], {}];

  const res = fakeRes();
  await health.ready({}, res);

  assert.equal(res.code, 200);
  assert.equal(res.body.checks.database.ok, true);
  assert.ok(typeof res.body.checks.database.latency_ms === "number");
});

test("readiness returns 503 when the database is unreachable", async () => {
  const { health, sequelize } = load();
  sequelize.query = async () => { throw new Error("Connection lost: The server closed the connection."); };

  const res = fakeRes();
  await health.ready({}, res);

  assert.equal(res.code, 503, "a monitor must be able to tell running from useful");
  assert.equal(res.body.status, "degraded");
  assert.equal(res.body.checks.database.ok, false);
});

test("a schema behind the code is surfaced but does not fail the check", async () => {
  // A dormant feature is worth knowing about; it is not a reason to pull a
  // serving instance out of rotation.
  const { health, sequelize } = load();
  sequelize.query = async (sql) => {
    if (/information_schema\.TABLES/i.test(sql)) return [[], {}];   // nothing exists
    if (/information_schema\.COLUMNS/i.test(sql)) return [[], {}];
    return [[{ 1: 1 }], {}];
  };

  const res = fakeRes();
  await health.ready({}, res);

  assert.equal(res.code, 200, "schema drift must not take the instance out of rotation");
  assert.equal(res.body.status, "ok_schema_behind");
  assert.ok(res.body.checks.schema.missing_tables > 0);
});

test("neither response leaks configuration", async () => {
  // These endpoints are unauthenticated, so anything in the body is public.
  const { health, sequelize } = load();
  sequelize.query = async () => [[{ 1: 1 }], {}];

  const live = fakeRes(); await health.live({}, live);
  const ready = fakeRes(); await health.ready({}, ready);
  const dump = JSON.stringify(live.body) + JSON.stringify(ready.body);

  for (const secret of [
    process.env.DB_PASSWORD, process.env.JWT_SECRET_KEY, process.env.ADMIN_API_KEY,
    process.env.TWILIO_AUTH_TOKEN, process.env.EMAIL_PASS,
  ]) {
    if (secret) assert.ok(!dump.includes(secret), "a secret appeared in a health response");
  }
  // Not even the database name or host, which tell an attacker where to aim.
  if (process.env.DB_NAME) assert.ok(!dump.includes(process.env.DB_NAME));
  if (process.env.DB_HOST && process.env.DB_HOST !== "127.0.0.1") {
    assert.ok(!dump.includes(process.env.DB_HOST));
  }
});
