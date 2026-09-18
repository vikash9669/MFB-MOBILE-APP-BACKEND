const test = require("node:test");
const assert = require("node:assert");

const { foldSamples, onlineMinutesIn, onlineMsIn } = require("../util/presence/spans");

// Presence is rebuilt from the phone's own timestamps. These tests pin the
// rules agreed for pay: a gap of up to 5 minutes is online, a longer one is
// not, an explicit go-offline ends presence at once, and the order samples
// arrive in never changes the answer.

const GAP = 5 * 60_000;
const T0 = Date.parse("2026-09-14T10:00:00+05:30");
const s = (sec) => T0 + sec * 1000;
const fix = (sec) => ({ kind: "fix", t: s(sec), lat: 24.6, lng: 74.6 });
const offline = (sec) => ({ kind: "offline", t: s(sec) });

/** Fixes every 5 seconds from `fromSec` to `toSec` inclusive. */
const every5s = (fromSec, toSec) => {
  const out = [];
  for (let t = fromSec; t <= toSec; t += 5) out.push(fix(t));
  return out;
};

const minutes = (spans) => onlineMinutesIn(spans, -Infinity, Infinity);
const shape = (spans) => spans.map((x) => [x.start_ms - T0, x.end_ms - T0, x.end_reason]);

test("an hour of 5-second fixes is one span of 60 minutes", () => {
  const { spans } = foldSamples([], every5s(0, 3600), GAP);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(minutes(spans), 60);
  assert.strictEqual(spans[0].samples, 721);
});

test("a 3-minute gap (network blip) counts as online", () => {
  const { spans } = foldSamples([], [...every5s(0, 600), ...every5s(780, 1200)], GAP);
  assert.strictEqual(spans.length, 1);
  assert.strictEqual(minutes(spans), 20);
});

test("a gap of exactly 5 minutes still counts; just over 5 minutes does not", () => {
  const exact = foldSamples([], [fix(0), fix(300)], GAP).spans;
  assert.strictEqual(exact.length, 1);
  assert.strictEqual(minutes(exact), 5);

  const over = foldSamples([], [fix(0), fix(301)], GAP).spans;
  assert.strictEqual(over.length, 2);
  assert.strictEqual(onlineMsIn(over, -Infinity, Infinity), 0);
});

test("a 7-minute gap (location off) is offline from the last fix to the next", () => {
  const { spans } = foldSamples([], [...every5s(0, 600), ...every5s(1020, 1620)], GAP);
  assert.deepStrictEqual(shape(spans), [
    [0, 600_000, null],
    [1_020_000, 1_620_000, null],
  ]);
  assert.strictEqual(minutes(spans), 20);
});

test("an explicit go-offline ends the span at once — a fix 1 minute later starts a new one", () => {
  const { spans } = foldSamples([], [...every5s(0, 600), offline(610), ...every5s(670, 900)], GAP);
  assert.deepStrictEqual(shape(spans), [
    [0, 610_000, "offline"],
    [670_000, 900_000, null],
  ]);
  // 10:10 of the first span + 3:50 of the second, in whole minutes.
  assert.strictEqual(minutes(spans), 14);
});

test("a go-offline with nothing running leaves only a zero-length marker (no online time)", () => {
  const { spans } = foldSamples([], [offline(0)], GAP);
  assert.deepStrictEqual(shape(spans), [[0, 0, "offline"]]);
  assert.strictEqual(minutes(spans), 0);
});

test("fixes that arrive AFTER the go-offline they led up to still end at the tap", () => {
  // The tap reached the server first (a retried upload overtook the earlier one).
  const first = foldSamples([], [offline(610)], GAP).spans.map((x) => ({ ...x, span_id: 1 }));
  const { spans } = foldSamples(first, [...every5s(0, 600), ...every5s(670, 900)], GAP);
  assert.deepStrictEqual(shape(spans), [
    [0, 610_000, "offline"],
    [670_000, 900_000, null],
  ]);
});

test("fixes continuing straight after a go-offline mean the rider came back online", () => {
  const { spans } = foldSamples([], [...every5s(0, 600), offline(300)], GAP);
  assert.deepStrictEqual(shape(spans), [
    [0, 300_000, "offline"],
    [305_000, 600_000, null],
  ]);
});

test("a backlog synced after newer live samples lands in the same place", () => {
  // Phone offline from 10:10 to 10:16:40 kept sampling; live data after the
  // reconnect reached the server first, the backlog second.
  const live = [...every5s(0, 600), ...every5s(1000, 1200)];
  const backlog = every5s(605, 995);

  const inOrder = foldSamples([], [...live, ...backlog], GAP).spans;

  let stored = foldSamples([], live, GAP).spans.map((x, i) => ({ ...x, span_id: i + 1 }));
  const late = foldSamples(stored, backlog, GAP);

  assert.deepStrictEqual(shape(late.spans), shape(inOrder));
  assert.strictEqual(minutes(late.spans), 20);
  // The two stored spans the backlog bridged collapse into the first one.
  assert.deepStrictEqual(late.removed, [2]);
  assert.strictEqual(late.spans[0].span_id, 1);
});

test("the same samples in any order give the same spans", () => {
  const samples = [...every5s(0, 300), ...every5s(400, 700), offline(705), ...every5s(1300, 1500)];
  const expected = shape(foldSamples([], samples, GAP).spans);
  for (let run = 0; run < 20; run += 1) {
    const shuffled = [...samples].sort(() => Math.random() - 0.5);
    // foldSamples sorts a batch itself; feed them in several separate batches
    // too, which is what an unreliable network actually does.
    let spans = [];
    for (let i = 0; i < shuffled.length; i += 37) {
      spans = foldSamples(spans, shuffled.slice(i, i + 37), GAP).spans.map((x, k) => ({
        ...x,
        span_id: x.span_id ?? 1000 * run + i + k,
      }));
    }
    assert.deepStrictEqual(shape(spans), expected, `run ${run}`);
  }
});

test("online minutes are clipped to a window — how a day or a shift is measured", () => {
  const { spans } = foldSamples([], every5s(0, 7200), GAP); // 10:00–12:00
  const from = Date.parse("2026-09-14T11:30:00+05:30");
  const to = Date.parse("2026-09-14T13:00:00+05:30");
  assert.strictEqual(onlineMinutesIn(spans, from, to), 30);
});

// ── Internet outages: more than 5 minutes without a connection is offline ──

const net = (lostSec, backSec) => ({ kind: "net", t: s(backSec), lost_at: s(lostSec) });
const onlineOnly = (spans) => shape(spans.filter((x) => x.end_reason !== "blackout"));

test("a 7-minute outage is offline even though the phone kept recording fixes", () => {
  // Fixes every 5 s from 10:00 to 10:20 (the backlog included), connection lost
  // 10:05, back 10:12 — reported by the phone on reconnecting.
  const { spans } = foldSamples([], [...every5s(0, 1200), net(300, 720)], GAP);
  assert.deepStrictEqual(onlineOnly(spans), [
    [0, 300_000, null],
    [720_000, 1_200_000, null],
  ]);
  assert.strictEqual(minutes(spans), 13); // 5 + 8, the 7 offline minutes gone
});

test("an outage of 5 minutes or less changes nothing — the backlog counts", () => {
  const { spans } = foldSamples([], [...every5s(0, 1200), net(300, 480)], GAP);
  assert.deepStrictEqual(onlineOnly(spans), [[0, 1_200_000, null]]);
  assert.strictEqual(minutes(spans), 20);
  assert.ok(!spans.some((x) => x.end_reason === "blackout"));
});

test("the outage report arriving before the backlog gives the same answer", () => {
  const afterBacklog = foldSamples([], [...every5s(0, 1200), net(300, 720)], GAP).spans;

  // Reconnect event first (stored), then the backlog in a later upload.
  let stored = foldSamples([], [...every5s(720, 1200), net(300, 720)], GAP).spans.map((x, i) => ({ ...x, span_id: i + 1 }));
  const late = foldSamples(stored, every5s(0, 715), GAP).spans;

  assert.deepStrictEqual(onlineOnly(late), onlineOnly(afterBacklog));
  assert.strictEqual(minutes(late), 13);
});

test("the same outage reported twice is cut once", () => {
  const once = foldSamples([], [...every5s(0, 1200), net(300, 720)], GAP).spans;
  const twice = foldSamples(once, [net(300, 720)], GAP).spans;
  assert.deepStrictEqual(shape(twice), shape(once));
  assert.strictEqual(twice.filter((x) => x.end_reason === "blackout").length, 1);
});

test("an outage that swallows a whole span removes it", () => {
  const stored = foldSamples([], every5s(400, 600), GAP).spans.map((x) => ({ ...x, span_id: 9 }));
  const { spans, removed } = foldSamples(stored, [net(300, 720)], GAP);
  assert.deepStrictEqual(removed, [9]);
  assert.strictEqual(minutes(spans), 0);
});
