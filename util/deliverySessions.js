// Online-session bookkeeping and the active-time aggregates built from it.
//
// A partner's dp_online flag says only whether they are online right now. These
// helpers turn each online→offline stretch into a row, which is what "hours
// online" is measured from: inside a declared shift, and per day, week and
// month.
const { Op, fn, col, literal } = require("sequelize");
const { DeliverySession, DeliveryShift, DeliverySessionPoint } = require("../models");

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// Session tracking is additive: it enriches the shift screens, it is not what
// they are for. If its table or columns are missing — a deployment where the
// migration has not been run yet — the schedule must still load. Reads degrade
// to "no data" and warn once, rather than taking the screen down with them.
let warned = false;
async function safely(what, fallback, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.log(
        `MFB ~ session tracking unavailable (${what}): ${err.original?.sqlMessage || err.message}. ` +
          "Run migrations/2026-08-08-session-location.sql to enable it."
      );
    }
    return fallback;
  }
}
const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));

/** The shift covering this moment, if the partner declared one. */
async function shiftCovering(dpId, at) {
  const date = dayKey(at);
  const hhmm = new Date(at).toTimeString().slice(0, 5);
  const shifts = await DeliveryShift.findAll({ where: { dp_id: dpId, shift_date: date } });
  return (
    shifts.find(
      (s) => String(s.start_time).slice(0, 5) <= hhmm && hhmm <= String(s.end_time).slice(0, 5)
    ) ?? null
  );
}

/** The partner's currently-running session, if any. */
const openSession = (dpId) =>
  DeliverySession.findOne({
    where: { dp_id: dpId, ended_at: null },
    order: [["session_id", "DESC"]],
  });

/**
 * Opens a session when a partner goes online. Any session left dangling — the
 * app was killed, the device lost power — is closed first, so a forgotten
 * session can never run forever and inflate the totals.
 */
async function startSession(dpId, at = new Date(), coords = null) {
  return safely("startSession", null, async () => {
  const dangling = await openSession(dpId);
  // A dangling session gets no end coordinates: we have no idea where the
  // device was when it stopped reporting, and guessing with the current
  // position would be a lie.
  if (dangling) await closeSession(dpId, at);
  const shift = await shiftCovering(dpId, at);
  return DeliverySession.create({
    dp_id: dpId,
    shift_id: shift ? shift.shift_id : null,
    session_date: dayKey(at),
    started_at: at,
    ended_at: null,
    duration_min: 0,
    start_lat: coords?.lat ?? null,
    start_lng: coords?.lng ?? null,
  });
  });
}

/** Closes the running session and stamps its length. No-op if none is open. */
async function closeSession(dpId, at = new Date(), coords = null) {
  return safely("closeSession", null, async () => {
  const session = await openSession(dpId);
  if (!session) return null;
  // If GPS could not produce a fix at sign-off, the last breadcrumb is the
  // closest honest answer to where they finished.
  let end = coords;
  if (!end) {
    const last = await lastPointFor(session.session_id);
    if (last) end = { lat: Number(last.lat), lng: Number(last.lng) };
  }
  await session.update({
    ended_at: at,
    duration_min: minutesBetween(session.started_at, at),
    end_lat: end?.lat ?? null,
    end_lng: end?.lng ?? null,
  });
  return session;
  });
}

/**
 * Records a position sample against the running session.
 *
 * Also backfills the session's start point. GPS is often not ready at the exact
 * moment someone taps "go online", so rather than losing the start location we
 * take the first sample that arrives — which is what "keep trying until we
 * capture it" amounts to. Silently does nothing when no session is open, so a
 * stray push while offline cannot create orphan data.
 */
async function recordPoint(dpId, lat, lng, at = new Date()) {
  return safely("recordPoint", null, async () => {
  const session = await openSession(dpId);
  if (!session) return null;

  await DeliverySessionPoint.create({
    session_id: session.session_id,
    dp_id: dpId,
    recorded_at: at,
    lat,
    lng,
  });

  if (session.start_lat == null || session.start_lng == null) {
    await session.update({ start_lat: lat, start_lng: lng });
  }
  return session;
  });
}

/** The last sample recorded on a session — the best guess at where it ended
 *  when the device could not produce a fix at sign-off. */
async function lastPointFor(sessionId) {
  return DeliverySessionPoint.findOne({
    where: { session_id: sessionId },
    order: [["recorded_at", "DESC"]],
  });
}

/** Every sample on a session, oldest first. */
async function pointsForSession(sessionId) {
  return safely("pointsForSession", [], async () => {
  const rows = await DeliverySessionPoint.findAll({
    where: { session_id: sessionId },
    order: [["recorded_at", "ASC"]],
  });
  return rows.map((p) => ({
    at: p.recorded_at,
    lat: Number(p.lat),
    lng: Number(p.lng),
  }));
  });
}

/** Minutes online in [from, to], counting a running session up to now. */
async function activeMinutes(dpId, from, to) {
  return safely("activeMinutes", 0, async () => {
  const rows = await DeliverySession.findAll({
    where: { dp_id: dpId, session_date: { [Op.between]: [from, to] } },
    attributes: [
      [fn("SUM", col("duration_min")), "closed"],
      [
        fn(
          "SUM",
          literal("CASE WHEN ended_at IS NULL THEN TIMESTAMPDIFF(MINUTE, started_at, NOW()) ELSE 0 END")
        ),
        "running",
      ],
    ],
    raw: true,
  });
  const r = rows[0] || {};
  return Number(r.closed || 0) + Number(r.running || 0);
  });
}

/** Every session on a day, newest first, with a running one still open. */
async function sessionsForDay(dpId, date) {
  return safely("sessionsForDay", [], async () => {
  const rows = await DeliverySession.findAll({
    where: { dp_id: dpId, session_date: date },
    order: [["started_at", "ASC"]],
  });
  const point = (lat, lng) =>
    lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) };
  return rows.map((s) => ({
    id: s.session_id,
    shift_id: s.shift_id,
    started_at: s.started_at,
    ended_at: s.ended_at,
    running: s.ended_at == null,
    minutes: s.ended_at ? s.duration_min : minutesBetween(s.started_at, new Date()),
    start_point: point(s.start_lat, s.start_lng),
    end_point: point(s.end_lat, s.end_lng),
  }));
  });
}

/**
 * Day / week (Mon–Sun) / month online totals around a reference date.
 *
 * Measured from presence spans (util/presence/) — the 5-second location
 * samples with the 5-minute gap rule, the same numbers online pay is computed
 * from — in IST calendar days. Falls back to the toggle-based sessions below
 * only where the presence table does not exist yet.
 */
async function activeTotals(dpId, ref = new Date()) {
  try {
    const { istDateOf, istDayBounds, istAddDays } = require("./presence/config");
    const { spansBetween } = require("./presence/shifts");
    const { onlineMinutesIn } = require("./presence/spans");
    const refMs = new Date(ref).getTime();
    const nowMs = Math.min(Date.now(), refMs + 86_400_000);
    const today = istDateOf(refMs);
    const dow = (new Date(`${today}T12:00:00+05:30`).getUTCDay() + 6) % 7; // 0 = Monday
    const monday = istAddDays(today, -dow);
    const monthStart = `${today.slice(0, 8)}01`;
    const from = Math.min(istDayBounds(monday).startMs, istDayBounds(monthStart).startMs);
    const spans = await spansBetween(dpId, from, nowMs);
    const upTo = (date, days) => Math.min(nowMs, istDayBounds(istAddDays(date, days - 1)).endMs);
    return {
      day_min: onlineMinutesIn(spans, istDayBounds(today).startMs, upTo(today, 1)),
      week_min: onlineMinutesIn(spans, istDayBounds(monday).startMs, upTo(monday, 7)),
      month_min: onlineMinutesIn(spans, istDayBounds(monthStart).startMs, nowMs),
    };
  } catch {
    return legacyActiveTotals(dpId, ref);
  }
}

/** Session-based totals, for a database without presence spans. */
async function legacyActiveTotals(dpId, ref = new Date()) {
  const d = new Date(ref);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);

  const [day, week, month] = await Promise.all([
    activeMinutes(dpId, dayKey(d), dayKey(d)),
    activeMinutes(dpId, dayKey(monday), dayKey(sunday)),
    activeMinutes(dpId, dayKey(first), dayKey(last)),
  ]);
  return { day_min: day, week_min: week, month_min: month };
}

module.exports = {
  startSession,
  closeSession,
  openSession,
  activeMinutes,
  activeTotals,
  sessionsForDay,
  recordPoint,
  pointsForSession,
  lastPointFor,
  shiftCovering,
  dayKey,
};
