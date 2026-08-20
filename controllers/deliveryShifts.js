const { Op } = require("sequelize");
const { DeliveryShift, DeliveryPartner } = require("../models");
const { num } = require("../util/delivery");
const {
  activeTotals,
  sessionsForDay,
  activeMinutes,
} = require("../util/deliverySessions");

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const serializeShift = (s) => ({
  id: s.shift_id,
  date: s.shift_date,
  start_time: s.start_time,
  end_time: s.end_time,
  label: s.label,
  status: s.status,
  worked_min: num(s.worked_min),
  break_left_min: num(s.break_left_min),
  login_bonus: num(s.login_bonus),
  incentive_bonus: num(s.incentive_bonus),
});

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

    const active = await DeliveryShift.findOne({
      where: { dp_id: dpId, status: "active" },
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

    // One cell per weekday (Mon–Fri) with a booked/active marker.
    const week = [];
    for (let i = 0; i < 5; i += 1) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const s = weekShifts.find((w) => String(w.shift_date) === key);
      let dot = null;
      if (s) {
        dot = s.status === "active" ? "primary" : "success";
      }
      week.push({
        d: DOW[d.getDay()],
        n: String(d.getDate()),
        date: key,
        active: s ? s.status === "active" : false,
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

    const booked = weekShifts.reduce((h, s) => h + num(s.worked_min), 0);

    // Measured online time, as distinct from the declared schedule above.
    const today = now.toISOString().slice(0, 10);
    const [totals, sessions] = await Promise.all([
      activeTotals(dpId, now),
      sessionsForDay(dpId, today),
    ]);

    return {
      online: !!partner?.dp_online,
      active: active ? serializeShift(active) : null,
      week,
      week_booked_hours: Math.round(booked / 60),
      upcoming: upcoming.map(serializeShift),
      // Active time is what the partner was actually online for.
      active_time: totals,
      sessions_today: sessions,
    };
  }
}

exports.shiftOverview = shiftOverview;
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
    res.status(201).json({ message: "Shift added", shift: serializeShift(shift) });
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

/** A shift plus the online sessions that fell inside it. Shared with the panel. */
async function shiftDetail(shift) {
  const day = String(shift.shift_date).slice(0, 10);
  const all = await sessionsForDay(shift.dp_id, day);
  const inShift = all.filter((s) => s.shift_id === shift.shift_id);
  const online_min = inShift.reduce((t, s) => t + s.minutes, 0);
  const [sh, sm] = String(shift.start_time).slice(0, 5).split(":").map(Number);
  const [eh, em] = String(shift.end_time).slice(0, 5).split(":").map(Number);
  const scheduled_min = Math.max(0, eh * 60 + em - (sh * 60 + sm));
  return {
    shift: serializeShift(shift),
    sessions: inShift,
    online_min,
    scheduled_min,
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
    res.json({ message: "Shift booked", shift: serializeShift(shift) });
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
    res.json({ message: `Shift extended by ${minutes} min`, shift: serializeShift(shift) });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery extend shift ~ err:", err);
    res.status(500).json({ message: "Failed to extend shift" });
  }
};
