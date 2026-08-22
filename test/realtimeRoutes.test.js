const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || "test-secret-for-realtime-routes";

const realtime = require("../controllers/admin/realtime");
const { publish, stats, _reset } = require("../util/realtime");

// The stream over a real socket. The unit tests cover the hub's bookkeeping;
// these cover the things only HTTP can get wrong — the auth gate on an endpoint
// that sits OUTSIDE the bearer middleware, and the response headers, which are
// the difference between a live stream and one a proxy buffers into silence.

const startServer = () => {
  const app = express();
  app.get("/admin/realtime/stream", realtime.stream);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    );
  });
};

const ticketFor = (payload, opts = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET_KEY, { expiresIn: 60, ...opts });

let ctx;
test.before(async () => {
  ctx = await startServer();
});
test.after(() => ctx.server.close());
test.beforeEach(() => _reset());

test("no ticket is refused", async () => {
  const res = await fetch(`${ctx.base}/admin/realtime/stream`);
  assert.strictEqual(res.status, 401);
  await res.body?.cancel();
});

test("a forged ticket is refused", async () => {
  const bad = jwt.sign({ scope: "admin_sse", role: 1 }, "not-the-real-secret");
  const res = await fetch(`${ctx.base}/admin/realtime/stream?ticket=${bad}`);
  assert.strictEqual(res.status, 401);
  await res.body?.cancel();
});

test("an expired ticket is refused", async () => {
  const expired = jwt.sign({ scope: "admin_sse", role: 1 }, process.env.JWT_SECRET_KEY, {
    expiresIn: -10,
  });
  const res = await fetch(`${ctx.base}/admin/realtime/stream?ticket=${expired}`);
  assert.strictEqual(res.status, 401);
  await res.body?.cancel();
});

test("a panel session token cannot be used as a stream ticket", async () => {
  // The 60-second lifetime is the entire reason a token in a query string is
  // acceptable here. If the 12-hour panel token also opened the stream, that
  // argument would be worthless — so scope is checked, not just the signature.
  const panelToken = jwt.sign(
    { scope: "admin_panel", user_id: 1, role: 1 },
    process.env.JWT_SECRET_KEY,
    { expiresIn: "12h" }
  );
  const res = await fetch(`${ctx.base}/admin/realtime/stream?ticket=${panelToken}`);
  assert.strictEqual(res.status, 401);
  await res.body?.cancel();
});

test("a valid ticket for a non-admin role is refused", async () => {
  // Role 3 is a rider. They can hold a valid panel session, so signature alone
  // would let them onto the admin stream.
  const res = await fetch(
    `${ctx.base}/admin/realtime/stream?ticket=${ticketFor({ scope: "admin_sse", user_id: 9, role: 3 })}`
  );
  assert.strictEqual(res.status, 403);
  await res.body?.cancel();
});

test("a valid admin ticket opens a stream with the right headers", async () => {
  const res = await fetch(
    `${ctx.base}/admin/realtime/stream?ticket=${ticketFor({ scope: "admin_sse", user_id: 1, role: 1 })}`
  );
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  // no-transform is as important as no-cache: a proxy that compresses this
  // buffers it, and a buffered event stream delivers nothing until it closes.
  assert.match(res.headers.get("cache-control"), /no-cache/);
  assert.match(res.headers.get("cache-control"), /no-transform/);
  // nginx — which is what sits in front of this on Render — buffers proxied
  // responses by default.
  assert.strictEqual(res.headers.get("x-accel-buffering"), "no");
  await res.body.cancel();
});

test("an event published after connect arrives on the wire", async () => {
  const res = await fetch(
    `${ctx.base}/admin/realtime/stream?ticket=${ticketFor({ scope: "admin_sse", user_id: 1, role: 1 })}`
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // The handshake: "retry" plus the ready event. Reading it also guarantees the
  // subscriber is registered before we publish.
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /retry: 5000/);
  assert.match(first, /event: ready/);

  assert.strictEqual(publish("rider.applied", { dp_id: 77 }, { audience: "admin" }), 1);

  const frame = decoder.decode((await reader.read()).value);
  assert.match(frame, /event: rider\.applied/);
  assert.match(frame, /"dp_id":77/);

  await reader.cancel();
});

test("a disconnected client is unsubscribed server-side", async () => {
  const res = await fetch(
    `${ctx.base}/admin/realtime/stream?ticket=${ticketFor({ scope: "admin_sse", user_id: 1, role: 1 })}`
  );
  const reader = res.body.getReader();
  await reader.read();
  assert.strictEqual(stats().clients, 1);

  await reader.cancel();

  // The close event crosses a socket, so give the event loop a moment.
  const freed = await new Promise((resolve) => {
    let tries = 0;
    const check = () => {
      if (stats().clients === 0 || tries > 50) return resolve(stats().clients === 0);
      tries += 1;
      setTimeout(check, 20);
    };
    check();
  });
  assert.ok(freed, "the subscriber was not released when the client went away");
});
