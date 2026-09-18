// Shift completion — how much of a rider's declared availability they were
// actually online for.
//
// A shift is the rider saying "I will be available 18:00–22:00". It does not
// affect pay (all online time is paid, see onlinePay.js); it is what admins
// read to see whether riders keep the hours they declare. Measured from the
// same presence spans as pay, so the two can never disagree.
const { QueryTypes } = require("sequelize");
const sequelize = require("../database");
const { onlineMsIn } = require("./spans");
const { presenceConfig, istDateOf, istAddDays } = require("./config");

const MINUTE_MS = 60_000;

/**
 * [startMs, endMs) of a shift, from its IST date and "HH:MM" times.
 *
 * An end at or before the start runs past midnight — /shifts/:id/extend wraps
 * the end time within the day, so "22:00–01:00" is a real shape.
 */
function shiftWindow(date, startTime, endTime) {
  const hhmm = (v) => String(v).slice(0, 5);
  const startMs = Date.parse(`${date}T${hhmm(startTime)}:00+05:30`);
  let endMs = Date.parse(`${date}T${hhmm(endTime)}:00+05:30`);
  if (endMs <= startMs) endMs += 24 * 3_600_000;
  return { startMs, endMs };
}

/**
 * Where a shift stands, given the rider's spans.
 *
 *   status      booked (not started) | active (running) | completed (ended)
 *   worked_min  online minutes inside the window (so far, for a running shift)
 *   offline_min minutes of the window NOT online (so far)
 *   completion  for an ended shift: full | partial | missed; null otherwise
 *
 * "full" allows up to one gap's worth of offline time, so a rider who goes
 * online a minute after the start still completed the shift — the same
 * tolerance the gap rule gives them everywhere else.
 */
function evaluateShift(spans, window, nowMs, gapMs) {
  const scheduledMin = Math.round((window.endMs - window.startMs) / MINUTE_MS);
  if (nowMs < window.startMs) {
    return { status: "booked", scheduled_min: scheduledMin, worked_min: 0, offline_min: 0, completion: null };
  }
  const until = Math.min(nowMs, window.endMs);
  const workedMin = Math.floor(onlineMsIn(spans, window.startMs, until) / MINUTE_MS);
  const elapsedMin = Math.round((until - window.startMs) / MINUTE_MS);
  const offlineMin = Math.max(0, elapsedMin - workedMin);

  if (nowMs < window.endMs) {
    return { status: "active", scheduled_min: scheduledMin, worked_min: workedMin, offline_min: offlineMin, completion: null };
  }
  let completion = "partial";
  if (workedMin === 0) completion = "missed";
  else if (offlineMin * MINUTE_MS <= gapMs) completion = "full";
  return { status: "completed", scheduled_min: scheduledMin, worked_min: workedMin, offline_min: offlineMin, completion };
}

/** A rider's spans overlapping [fromMs, toMs). */
async function spansBetween(dpId, fromMs, toMs, transaction) {
  const rows = await sequelize.query(
    `SELECT \`span_id\`, \`start_ms\`, \`end_ms\`, \`samples\`, \`end_reason\`
       FROM \`store_rider_presence_spans\`
      WHERE \`dp_id\` = :dpId AND \`end_ms\` > :from AND \`start_ms\` < :to
      ORDER BY \`start_ms\``,
    { replacements: { dpId, from: fromMs, to: toMs }, type: QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => ({
    span_id: Number(r.span_id),
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    samples: Number(r.samples),
    end_reason: r.end_reason ?? null,
  }));
}

/**
 * Writes status / worked_min / offline_min / completion for every booked shift
 * that has started in the backfill window. Re-evaluates ended shifts too, so a
 * backlog synced late still counts. Returns how many shifts changed.
 */
async function evaluateRecentShifts({ nowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const today = istDateOf(nowMs);
  const fromDate = istAddDays(today, -Math.ceil(cfg.backfillMs / 86_400_000) - 1);

  const shifts = await sequelize.query(
    `SELECT \`shift_id\`, \`dp_id\`, DATE_FORMAT(\`shift_date\`, '%Y-%m-%d') AS \`d\`,
            \`start_time\`, \`end_time\`, \`status\`, \`worked_min\`, \`offline_min\`, \`completion\`
       FROM \`store_delivery_shifts\`
      WHERE \`shift_date\` BETWEEN :fromDate AND :today
        AND \`status\` IN ('booked', 'active', 'completed')`,
    { replacements: { fromDate, today }, type: QueryTypes.SELECT }
  );

  let changed = 0;
  for (const shift of shifts) {
    const window = shiftWindow(shift.d, shift.start_time, shift.end_time);
    if (nowMs < window.startMs) continue;
    const spans = await spansBetween(shift.dp_id, window.startMs, window.endMs);
    const result = evaluateShift(spans, window, nowMs, cfg.gapMs);
    const same =
      shift.status === result.status &&
      Number(shift.worked_min) === result.worked_min &&
      Number(shift.offline_min) === result.offline_min &&
      (shift.completion ?? null) === result.completion;
    if (same) continue;
    await sequelize.query(
      `UPDATE \`store_delivery_shifts\`
          SET \`status\` = :status, \`worked_min\` = :worked, \`offline_min\` = :offline,
              \`completion\` = :completion, \`evaluated_ms\` = :now
        WHERE \`shift_id\` = :id`,
      {
        replacements: {
          status: result.status,
          worked: result.worked_min,
          offline: result.offline_min,
          completion: result.completion,
          now: nowMs,
          id: shift.shift_id,
        },
        type: QueryTypes.UPDATE,
      }
    );
    changed += 1;
  }
  return changed;
}

/**
 * Live completion for shifts being shown right now — what the rider's Shifts
 * screen and the admin panel read, so a running shift is current without
 * waiting for the hourly job. Takes shift rows with shift_id, dp_id, shift_date,
 * start_time, end_time. Returns a Map shift_id → evaluateShift result.
 */
async function liveCompletion(shiftRows, { nowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const out = new Map();
  for (const s of shiftRows) {
    const date = typeof s.shift_date === "string" ? s.shift_date.slice(0, 10) : istDateOf(new Date(s.shift_date).getTime());
    const window = shiftWindow(date, s.start_time, s.end_time);
    const spans = nowMs < window.startMs ? [] : await spansBetween(s.dp_id, window.startMs, window.endMs).catch(() => []);
    out.set(s.shift_id, evaluateShift(spans, window, nowMs, cfg.gapMs));
  }
  return out;
}

module.exports = { shiftWindow, evaluateShift, spansBetween, evaluateRecentShifts, liveCompletion };
