const { Op } = require("sequelize");
const { DeliveryShift, DeliveryPartner } = require("../models");
const { num } = require("../util/delivery");
const {
  activeTotals,
  sessionsForDay,
  activeMinutes,
} = require("../util/deliverySessions");
const { liveCompletion } = require("../util/presence/shifts");
const { accruedToday } = require("../util/presence/onlinePay");

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * One shift for the app and the panel.
 *
 * `live` is the result of util/presence/shifts.liveCompletion for this shift:
 * status, worked and offline minutes measured from the rider's actual online
 * time right now. Without it the stored columns are used, which the hourly job
 * keeps current for ended shifts.
 */
const serializeShift = (s, live = null) => ({
  id: s.shift_id,
  date: s.shift_date,
  start_time: s.start_time,
  end_time: s.end_time,
  label: s.label,
  status: live?.status ?? s.status,
  scheduled_min: live?.scheduled_min ?? null,
  worked_min: live ? live.worked_min : num(s.worked_min),
  offline_min: live ? live.offline_min : null,
  // full | partial | missed once the shift has ended; null before.
  completion: live ? live.completion : null,
  break_left_min: num(s.break_left_min),
  login_bonus: num(s.login_bonus),
  incentive_bonus: num(s.incentive_bonus),
});

/** liveCompletion, degrading to "no live data" if presence is unavailable. */
async function liveFor(rows) {
  try {
    return await liveCompletion(rows.map((r) => (typeof r.get === "function" ? r.get({ plain: true }) : r)));
  } catch {
    return new Map();
  }
}

// GET /delivery/shifts — active shift, this-week strip, and upcoming shifts.
// Also reports the partner's online flag: the Shifts screen's Pause/Resume
// control is an online toggle, so it needs the server's state to label itself.
/**
 * The shift overview for one partner: online flag, active shift, this week's
 * strip, hours booked and the next few slots. Shared by the partner app
 * (GET /delivery/shifts) and the panel (controllers/admin/shifts.js), so both
 * always show the same thing.
 */
async function shiftOverview(dpId) {
  {
    const partner = await DeliveryPartner.findByPk(dpId, {
      attributes: ["dp_online"],
    });

    // Monday-to-Sunday window for the week strip.
    const now = new Date();
    const monday = new Date(now);
    const offset = (now.getDay() + 6) % 7; // days since Monday
    monday.setDate(now.getDate() - offset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const weekShifts = await DeliveryShift.findAll({
      where: {
        dp_id: dpId,
        shift_date: {
          [Op.between]: [monday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10)],
        },
      },
    });

    // Live status for the week: a shift is active because the clock is inside
    // its window, and completed with the time the rider was really online.
    const weekLive = await liveFor(weekShifts);
    const liveOf = (s) => weekLive.get(s.shift_id) ?? null;
    const active = weekShifts.find((s) => liveOf(s)?.status === "active") ?? null;

    // One cell per weekday (Mon–Fri) with a booked/active/completed marker.
    const week = [];
    for (let i = 0; i < 5; i += 1) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const s = weekShifts.find((w) => String(w.shift_date) === key);
      let dot = null;
      const live = s ? liveOf(s) : null;
      if (s) {
        if (live?.status === "active") dot = "primary";
        else if (live?.completion === "missed") dot = "danger";
        else if (live?.completion === "partial") dot = "warning";
        else dot = "success";
      }
      week.push({
        d: DOW[d.getDay()],
        n: String(d.getDate()),
        date: key,
        active: live?.status === "active",
        completion: live?.completion ?? null,
        dot,
      });
    }

    const upcoming = await DeliveryShift.findAll({
      where: {
        dp_id: dpId,
        status: { [Op.in]: ["available", "booked"] },
        shift_date: { [Op.gte]: now.toISOString().slice(0, 10) },
      },
      order: [["shift_date", "ASC"], ["start_time", "ASC"]],
      limit: 6,
    });

    // Hours the rider DECLARED this week — worked_min was never filled in, so
    // this always read 0. What they were actually online for is active_time.
    const booked = weekShifts.reduce((h, s) => h + (liveOf(s)?.scheduled_min ?? 0), 0);
    const upcomingLive = await liveFor(upcoming);

    // Measured online time, as distinct from the declared schedule above.
    const today = now.toISOString().slice(0, 10);
    const [totals, sessions, onlinePay] = await Promise.all([
      activeTotals(dpId, now),
      sessionsForDay(dpId, today),
      accruedToday(dpId).catch(() => null),
    ]);

    return {
      online: !!partner?.dp_online,
      active: active ? serializeShift(active, liveOf(active)) : null,
      week,
      week_booked_hours: Math.round(booked / 60),
      upcoming: upcoming.map((s) => serializeShift(s, upcomingLive.get(s.shift_id))),
      // Active time is what the partner was actually online for.
      active_time: totals,
      sessions_today: sessions,
      // Today's online time and what it is worth so far; credited after midnight.
      online_pay_today: onlinePay,
    };
  }
}

exports.shiftOverview = shiftOverview;
exports.liveFor = liveFor;
exports.serializeShift = serializeShift;

exports.getShifts = async (req, res) => {
  try {
    res.json(await shiftOverview(req.user.dp_id));
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getShifts ~ err:", err);
    res.status(500).json({ message: "Failed to load shifts" });
  }
};

// POST /delivery/shifts — a partner declares availability for a date and range.
// The only way a shift comes into existence outside the demo seeder.
exports.create = async (req, res) => {
  try {
    const { date, start_time, end_time, label } = req.body;
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!date || !hhmm.test(String(start_time)) || !hhmm.test(String(end_time))) {
      return res
        .status(400)
        .json({ message: "date, start_time and end_time (HH:MM) are required" });
    }
    if (String(start_time) >= String(end_time)) {
      return res.status(400).json({ message: "end_time must be after start_time" });
    }

    // Overlapping declarations on one day would make "hours online in this
    // shift" ambiguous, so they are refused rather than silently merged.
    const sameDay = await DeliveryShift.findAll({
      where: { dp_id: req.user.dp_id, shift_date: date },
    });
    const clash = sameDay.find(
      (s) =>
        String(start_time) < String(s.end_time).slice(0, 5) &&
        String(s.start_time).slice(0, 5) < String(end_time)
    );
    if (clash) {
      return res.status(409).json({
        message: `That overlaps your ${String(clash.start_time).slice(0, 5)}–${String(
          clash.end_time
        ).slice(0, 5)} shift on the same day`,
      });
    }

    const shift = await DeliveryShift.create({
      dp_id: req.user.dp_id,
      shift_date: date,
      start_time,
      end_time,
      label: label || null,
      status: "booked",
    });
    const live = await liveFor([shift]);
    res.status(201).json({ message: "Shift added", shift: serializeShift(shift, live.get(shift.shift_id)) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery create shift ~ err:", err);
    res.status(500).json({ message: "Failed to add shift" });
  }
};

// DELETE /delivery/shifts/:id — drop a declared shift that has not started.
exports.remove = async (req, res) => {
  try {
    const shift = await DeliveryShift.findOne({
      where: { shift_id: req.params.id, dp_id: req.user.dp_id },
    });
    if (shift == null) return res.status(404).json({ message: "Shift not found" });
    if (shift.status === "active") {
      return res.status(409).json({ message: "Can't remove a shift that is running" });
    }
    await shift.destroy();
    res.json({ message: "Shift removed" });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery remove shift ~ err:", err);
    res.status(500).json({ message: "Failed to remove shift" });
  }
};

// GET /delivery/shifts/:id — one shift with the sessions worked inside it.
exports.detail = async (req, res) => {
  try {
    const shift = await DeliveryShift.findOne({
      where: { shift_id: req.params.id, dp_id: req.user.dp_id },
    });
    if (shift == null) return res.status(404).json({ message: "Shift not found" });
    res.json(await shiftDetail(shift));
  } catch (err) {
    console.log("MFB-error-logs ~ delivery shift detail ~ err:", err);
    res.status(500).json({ message: "Failed to load shift" });
  }
};

/**
 * A shift, how much of it the rider was online for, and the sessions (with
 * their trails) that fell inside it. Shared with the panel.
 *
 * online_min comes from presence spans, so it follows the 5-minute gap rule and
 * includes time synced late from the phone. The sessions are the online/offline
 * toggles, kept for the map trail.
 */
async function shiftDetail(shift) {
  const day = String(shift.shift_date).slice(0, 10);
  const all = await sessionsForDay(shift.dp_id, day);
  const inShift = all.filter((s) => s.shift_id === shift.shift_id);
  const live = (await liveFor([shift])).get(shift.shift_id) ?? null;
  const [sh, sm] = String(shift.start_time).slice(0, 5).split(":").map(Number);
  const [eh, em] = String(shift.end_time).slice(0, 5).split(":").map(Number);
  const fallbackScheduled = Math.max(0, eh * 60 + em - (sh * 60 + sm));
  const scheduled_min = live?.scheduled_min ?? fallbackScheduled;
  const online_min = live ? live.worked_min : inShift.reduce((t, s) => t + s.minutes, 0);
  return {
    shift: serializeShift(shift, live),
    sessions: inShift,
    online_min,
    offline_min: live ? live.offline_min : Math.max(0, scheduled_min - online_min),
    scheduled_min,
    completion: live?.completion ?? null,
    // Share of the declared window actually spent online.
    coverage: scheduled_min ? Math.min(1, online_min / scheduled_min) : 0,
  };
}

exports.shiftDetail = shiftDetail;
exports.activeMinutesFor = activeMinutes;

// POST /delivery/shifts/:id/book — book an available shift slot.
exports.book = async (req, res) => {
  try {
    const shift = await DeliveryShift.findOne({
      where: { shift_id: req.params.id, dp_id: req.user.dp_id },
    });
    if (shift == null) {
      return res.status(404).json({ message: "Shift not found" });
    }
    if (shift.status !== "available") {
      return res.status(409).json({ message: "Shift can't be booked" });
    }
    await shift.update({ status: "booked" });
    const live = await liveFor([shift]);
    res.json({ message: "Shift booked", shift: serializeShift(shift, live.get(shift.shift_id)) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery book shift ~ err:", err);
    res.status(500).json({ message: "Failed to book shift" });
  }
};

// POST /delivery/shifts/:id/extend — push the shift end time out by N minutes
// (default 60). Wraps within the day.
exports.extend = async (req, res) => {
  try {
    const shift = await DeliveryShift.findOne({
      where: { shift_id: req.params.id, dp_id: req.user.dp_id },
    });
    if (shift == null) {
      return res.status(404).json({ message: "Shift not found" });
    }
    const minutes = Number(req.body.minutes) || 60;
    const [h, m] = String(shift.end_time).split(":").map(Number);
    const total = ((h * 60 + m + minutes) % (24 * 60) + 24 * 60) % (24 * 60);
    const end = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    await shift.update({ end_time: end });
    const live = await liveFor([shift]);
    res.json({ message: `Shift extended by ${minutes} min`, shift: serializeShift(shift, live.get(shift.shift_id)) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery extend shift ~ err:", err);
    res.status(500).json({ message: "Failed to extend shift" });
  }
};
