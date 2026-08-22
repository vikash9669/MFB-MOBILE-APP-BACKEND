const test = require("node:test");
const assert = require("node:assert");

const { subscribe, publish, stats, _reset } = require("../util/realtime");

// A stand-in for an Express response. Records what was written and can be made
// to fail the way a socket whose peer has gone away does.
const fakeRes = () => {
  const chunks = [];
  return {
    chunks,
    dead: false,
    write(c) {
      if (this.dead) throw new Error("EPIPE: socket closed");
      chunks.push(c);
      return true;
    },
    text: () => chunks.join(""),
  };
};

test.beforeEach(() => _reset());

test("a subscriber receives a published event, framed as SSE", () => {
  const res = fakeRes();
  subscribe(res, { audience: "admin" });

  const delivered = publish("rider.applied", { dp_id: 42 }, { audience: "admin" });

  assert.strictEqual(delivered, 1);
  // The wire format is not cosmetic: EventSource requires "event:" and "data:"
  // lines and a BLANK LINE to terminate the frame. Without the trailing \n\n
  // the browser holds the event forever, waiting for the rest of it.
  assert.strictEqual(res.text(), 'event: rider.applied\ndata: {"dp_id":42}\n\n');
});

test("an event is only delivered to its own audience", () => {
  // The whole point of the audience field. A vendor or rider stream added later
  // must not be able to receive admin events by existing.
  const adminRes = fakeRes();
  const otherRes = fakeRes();
  subscribe(adminRes, { audience: "admin" });
  subscribe(otherRes, { audience: "vendor" });

  const delivered = publish("rider.applied", { dp_id: 1 }, { audience: "admin" });

  assert.strictEqual(delivered, 1);
  assert.match(adminRes.text(), /rider\.applied/);
  assert.strictEqual(otherRes.text(), "", "a vendor stream received an admin event");
});

test("unsubscribing stops delivery and frees the client", () => {
  const res = fakeRes();
  const unsubscribe = subscribe(res, { audience: "admin" });
  assert.strictEqual(stats().clients, 1);

  unsubscribe();

  assert.strictEqual(stats().clients, 0);
  assert.strictEqual(publish("rider.applied", {}, { audience: "admin" }), 0);
});

test("unsubscribing twice is harmless", () => {
  // Both req.on("close") and req.on("aborted") are wired to this, and for some
  // disconnects both fire.
  const unsubscribe = subscribe(fakeRes(), { audience: "admin" });
  unsubscribe();
  unsubscribe();
  assert.strictEqual(stats().clients, 0);
});

test("a client whose socket has died is dropped, and the others still get it", () => {
  // The failure this guards: one closed laptop must not stop the event reaching
  // everyone else, and the dead client must not stay in the set being written
  // to by the heartbeat forever.
  const dead = fakeRes();
  const alive = fakeRes();
  subscribe(dead, { audience: "admin" });
  subscribe(alive, { audience: "admin" });
  dead.dead = true;

  const delivered = publish("rider.applied", { dp_id: 7 }, { audience: "admin" });

  assert.strictEqual(delivered, 1, "the live client should still have been reached");
  assert.strictEqual(stats().clients, 1, "the dead client should have been dropped");
  assert.match(alive.text(), /rider\.applied/);
});

test("publishing with nobody listening is a no-op, not an error", () => {
  assert.strictEqual(publish("rider.applied", { dp_id: 1 }, { audience: "admin" }), 0);
});

test("payloads that would break the frame are escaped by JSON", () => {
  // A rider's name is user input and goes into the payload. A raw newline in it
  // would terminate the data line early and split one event into two malformed
  // ones. JSON.stringify is what prevents that — this asserts it stays.
  const res = fakeRes();
  subscribe(res, { audience: "admin" });
  publish("rider.applied", { name: "Ravi\n\ndata: injected" }, { audience: "admin" });

  const frame = res.text();
  const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
  assert.strictEqual(dataLines.length, 1, "payload broke out of its data line");
  assert.ok(frame.endsWith("\n\n"));
});

test("stats reports open connections per audience", () => {
  subscribe(fakeRes(), { audience: "admin" });
  subscribe(fakeRes(), { audience: "admin" });
  subscribe(fakeRes(), { audience: "vendor" });
  assert.deepStrictEqual(stats(), { clients: 3, byAudience: { admin: 2, vendor: 1 } });
});

test("a thousand connect/disconnect cycles leave nothing behind", () => {
  // Every closed browser tab runs this path. A leak here is invisible until the
  // process has been up for a week and the heartbeat is writing to thousands of
  // dead sockets.
  for (let i = 0; i < 1000; i += 1) {
    const unsubscribe = subscribe(fakeRes(), { audience: "admin" });
    unsubscribe();
  }
  assert.strictEqual(stats().clients, 0);
});
