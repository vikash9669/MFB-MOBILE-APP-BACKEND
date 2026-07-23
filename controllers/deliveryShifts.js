const { Op } = require("sequelize");
const { DeliveryShift } = require("../models");
const { num } = require("../util/delivery");

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
exports.getShifts = async (req, res) => {
  try {
    const dpId = req.user.dp_id;

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
      week.push({
        d: DOW[d.getDay()],
        n: String(d.getDate()),
        date: key,
        active: s ? s.status === "active" : false,
        dot: s ? (s.status === "active" ? "primary" : "success") : null,
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

    res.json({
      active: active ? serializeShift(active) : null,
      week,
      week_booked_hours: Math.round(booked / 60),
      upcoming: upcoming.map(serializeShift),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ delivery getShifts ~ err:", err);
    res.status(500).json({ message: "Failed to load shifts", err });
  }
};

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
    res.status(500).json({ message: "Failed to book shift", err });
  }
};
