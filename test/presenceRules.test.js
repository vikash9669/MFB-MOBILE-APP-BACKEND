const test = require("node:test");
const assert = require("node:assert");

const { normalizeBatch } = require("../util/presence/ingest");
const { paiseFor } = require("../util/presence/onlinePay");
const { shiftWindow, evaluateShift } = require("../util/presence/shifts");
const { istDateOf, istDayBounds, istAddDays } = require("../util/presence/config");
const { foldSamples } = require("../util/presence/spans");

const GAP = 5 * 60_000;
const NOW = Date.parse("2026-09-15T18:00:00+05:30");

// ── Uploads ────────────────────────────────────────────────────────────

test("a batch is corrected by the phone's clock skew, and small latency is left alone", () => {
  const phoneAhead = 10 * 60_000; // phone clock 10 minutes fast
  const samples = [{ seq: 1, t: NOW - 5000 + phoneAhead, kind: "fix", lat: 24.6, lng: 74.6 }];
  const skewed = normalizeBatch(samples, { clientNowMs: NOW + phoneAhead, serverNowMs: NOW });
  assert.strictEqual(skewed.skewMs, -phoneAhead);
  assert.strictEqual(skewed.samples[0].t, NOW - 5000);

  const latency = normalizeBatch([{ seq: 1, t: NOW - 5000, kind: "fix", lat: 24.6, lng: 74.6 }], {
    clientNowMs: NOW - 4000,
    serverNowMs: NOW,
  });
  assert.strictEqual(latency.skewMs, 0);
  assert.strictEqual(latency.samples[0].t, NOW - 5000);
});

test("impossible samples are refused but still acknowledged, so the phone stops resending them", () => {
  const { samples, rejected, maxSeq } = normalizeBatch(
    [
      { seq: 10, t: NOW - 1000, kind: "fix", lat: 24.6, lng: 74.6 },
      { seq: 11, t: NOW + 10 * 60_000, kind: "fix", lat: 24.6, lng: 74.6 }, // future
      { seq: 12, t: NOW - 80 * 3_600_000, kind: "fix", lat: 24.6, lng: 74.6 }, // beyond 72 h
      { seq: 13, t: NOW - 900, kind: "fix", lat: 0, lng: 0 }, // null island
      { seq: 14, t: NOW - 800, kind: "fix", lat: 124.6, lng: 74.6 }, // out of range
      { seq: 15, t: NOW - 700, kind: "teleport" },
      { seq: 16, t: NOW - 600, kind: "offline" },
    ],
    { serverNowMs: NOW }
  );
  assert.deepStrictEqual(samples.map((s) => s.seq), [10, 16]);
  assert.strictEqual(rejected, 5);
  assert.strictEqual(maxSeq, 16);
});

test("a 72-hour offline backlog is still accepted", () => {
  const { samples } = normalizeBatch([{ seq: 1, t: NOW - 71 * 3_600_000, kind: "fix", lat: 24.6, lng: 74.6 }], {
    serverNowMs: NOW,
  });
  assert.strictEqual(samples.length, 1);
});

// ── Pay ────────────────────────────────────────────────────────────────

test("online pay is ₹10/hour pro-rata per whole minute", () => {
  assert.strictEqual(paiseFor(60, 10), 1000); // 1 h = ₹10
  assert.strictEqual(paiseFor(720, 10), 12000); // 12 h = ₹120
  assert.strictEqual(paiseFor(45, 10), 750); // 45 min = ₹7.50
  assert.strictEqual(paiseFor(1, 10), 17); // 1 min = ₹0.1666… → 17 paise
  assert.strictEqual(paiseFor(0, 10), 0);
});

test("IST days are computed in IST, whatever the server's own timezone", () => {
  // 23:59 IST on the 14th is 18:29 UTC — still the 14th in India.
  assert.strictEqual(istDateOf(Date.parse("2026-09-14T23:59:00+05:30")), "2026-09-14");
  assert.strictEqual(istDateOf(Date.parse("2026-09-15T00:00:00+05:30")), "2026-09-15");
  const { startMs, endMs } = istDayBounds("2026-09-14");
  assert.strictEqual(new Date(startMs).toISOString(), "2026-09-13T18:30:00.000Z");
  assert.strictEqual(endMs - startMs, 24 * 3_600_000);
  assert.strictEqual(istAddDays("2026-09-01", -1), "2026-08-31");
});

test("online time crossing midnight is paid to the day each minute belongs to", () => {
  const every5s = (from, to) => {
    const out = [];
    for (let t = from; t <= to; t += 5000) out.push({ kind: "fix", t, lat: 24.6, lng: 74.6 });
    return out;
  };
  // 22:00 on the 14th to 02:00 on the 15th.
  const { spans } = foldSamples(
    [],
    every5s(Date.parse("2026-09-14T22:00:00+05:30"), Date.parse("2026-09-15T02:00:00+05:30")),
    GAP
  );
  const { onlineMinutesIn } = require("../util/presence/spans");
  const d14 = istDayBounds("2026-09-14");
  const d15 = istDayBounds("2026-09-15");
  assert.strictEqual(onlineMinutesIn(spans, d14.startMs, d14.endMs), 120);
  assert.strictEqual(onlineMinutesIn(spans, d15.startMs, d15.endMs), 120);
});

// ── Shifts ─────────────────────────────────────────────────────────────

const span = (fromIso, toIso) => ({ start_ms: Date.parse(fromIso), end_ms: Date.parse(toIso), samples: 1, end_reason: null });

test("a shift window is in IST, and an end before the start runs past midnight", () => {
  const w = shiftWindow("2026-09-14", "18:00", "22:00");
  assert.strictEqual(new Date(w.startMs).toISOString(), "2026-09-14T12:30:00.000Z");
  assert.strictEqual((w.endMs - w.startMs) / 60_000, 240);
  const late = shiftWindow("2026-09-14", "22:00:00", "01:00");
  assert.strictEqual((late.endMs - late.startMs) / 60_000, 180);
});

test("a shift fully online is completed 'full', even going online a minute late", () => {
  const w = shiftWindow("2026-09-14", "18:00", "22:00");
  const r = evaluateShift([span("2026-09-14T18:01:00+05:30", "2026-09-14T22:30:00+05:30")], w, NOW, GAP);
  assert.deepStrictEqual(r, { status: "completed", scheduled_min: 240, worked_min: 239, offline_min: 1, completion: "full" });
});

test("an hour offline inside a shift makes it 'partial', with the offline minutes counted", () => {
  const w = shiftWindow("2026-09-14", "18:00", "22:00");
  const r = evaluateShift(
    [
      span("2026-09-14T18:00:00+05:30", "2026-09-14T19:00:00+05:30"),
      span("2026-09-14T20:00:00+05:30", "2026-09-14T22:00:00+05:30"),
    ],
    w,
    NOW,
    GAP
  );
  assert.strictEqual(r.completion, "partial");
  assert.strictEqual(r.worked_min, 180);
  assert.strictEqual(r.offline_min, 60);
});

test("a shift with no online time is 'missed'; one not started is 'booked'; one running is 'active'", () => {
  const ended = shiftWindow("2026-09-14", "08:00", "12:00");
  assert.strictEqual(evaluateShift([], ended, NOW, GAP).completion, "missed");

  const later = shiftWindow("2026-09-15", "20:00", "23:00");
  assert.strictEqual(evaluateShift([], later, NOW, GAP).status, "booked");

  const running = shiftWindow("2026-09-15", "17:00", "21:00");
  const r = evaluateShift([span("2026-09-15T17:00:00+05:30", "2026-09-15T17:45:00+05:30")], running, NOW, GAP);
  assert.deepStrictEqual(r, { status: "active", scheduled_min: 240, worked_min: 45, offline_min: 15, completion: null });
});

test("a reconnect report carries when the connection was lost, corrected for clock skew", () => {
  const phoneAhead = 10 * 60_000;
  const { samples, rejected } = normalizeBatch(
    [
      { seq: 1, t: NOW - 60_000 + phoneAhead, kind: "net", lost_at: NOW - 8 * 60_000 + phoneAhead },
      { seq: 2, t: NOW - 50_000, kind: "net", lost_at: NOW - 40_000 }, // lost after reconnect: impossible
      { seq: 3, t: NOW - 40_000, kind: "net" }, // no lost_at
    ],
    { clientNowMs: NOW + phoneAhead, serverNowMs: NOW }
  );
  assert.deepStrictEqual(samples, [{ seq: 1, t: NOW - 60_000, kind: "net", lost_at: NOW - 8 * 60_000 }]);
  assert.strictEqual(rejected, 2);
});
