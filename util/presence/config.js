// Tunables for rider online time and online pay. See RIDER_ONLINE_PAY.md.
//
// Read on every call rather than captured at require time, so a test (or an
// operator restarting with a different env) never gets a stale value.

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : fallback;
};
const bool = (v, fallback) =>
  v == null || String(v).trim() === "" ? fallback : String(v).toLowerCase() === "true";

function presenceConfig() {
  return {
    /** A gap between two fixes up to this long still counts as online. */
    gapMs: num(process.env.PRESENCE_GAP_MIN, 5) * 60_000,
    /** How old a sample may be and still be accepted — the offline backlog. */
    backfillMs: num(process.env.PRESENCE_BACKFILL_HOURS, 72) * 3_600_000,
    /** A sample this far in the future (after skew correction) is refused. */
    futureMs: 2 * 60_000,
    /** Clock skew below this is network latency, not a wrong clock. */
    skewToleranceMs: 30_000,
    /** Largest batch one upload may carry. */
    maxBatch: 1000,
    /** Rupees per online hour, paid pro-rata per whole minute. */
    payPerHour: num(process.env.RIDER_ONLINE_PAY_PER_HOUR, 10),
    payEnabled: bool(process.env.RIDER_ONLINE_PAY_ENABLED, true),
    /** A day is paid this long after it ends, so the last uploads can land. */
    paySettleDelayMs: num(process.env.RIDER_ONLINE_PAY_DELAY_MIN, 30) * 60_000,
    /** How often the pay / shift-completion job runs. */
    jobEveryMs: num(process.env.RIDER_ONLINE_PAY_JOB_MS, 60 * 60_000),
  };
}

// India has one zone and no daylight saving, so a fixed offset is exact.
const IST_OFFSET_MS = 330 * 60_000;

/** "YYYY-MM-DD" of the IST calendar day containing ms. */
const istDateOf = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** [startMs, endMs) of an IST calendar day. */
function istDayBounds(date) {
  const start = Date.parse(`${date}T00:00:00+05:30`);
  return { startMs: start, endMs: start + 24 * 3_600_000 };
}

/** The IST date `days` days before `date`. */
const istAddDays = (date, days) => istDateOf(istDayBounds(date).startMs + days * 24 * 3_600_000);

module.exports = { presenceConfig, IST_OFFSET_MS, istDateOf, istDayBounds, istAddDays };
