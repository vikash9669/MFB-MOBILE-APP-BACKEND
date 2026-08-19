// Shifts for the web panel — read-only.
//
// The delivery app owns shifts (controllers/deliveryShifts.js, partner token).
// The panel needs the same information from two angles:
//
//   GET /admin/portal/shifts   a rider's own shifts, mirroring their app
//   GET /admin/delivery/shifts every rider's shifts, for ops oversight
//
// Both reuse shiftOverview / the same tables, so the panel can never drift from
// what the partner sees. Nothing here writes: booking and extending stay in the
// app where they are already exercised.
const { Op } = require("sequelize");
const { DeliveryShift, DeliveryPartner, User } = require("../../models");
const { shiftOverview, serializeShift, shiftDetail } = require("../deliveryShifts");
const {
  activeTotals,
  sessionsForDay,
  pointsForSession,
} = require("../../util/deliverySessions");
const { normalizePhone } = require("../../util/riderLink");

/** The delivery partner behind a panel rider, matched on phone as elsewhere. */
async function partnerForPanelUser(userId) {
  const user = await User.findByPk(userId, { attributes: ["user_phone"] });
  if (!user) return null;
  const phone = normalizePhone(user.user_phone);
  if (!phone) return null;
  return DeliveryPartner.findOne({ where: { dp_phone: phone } });
}

// GET /admin/portal/shifts — the signed-in rider's own shifts.
exports.mine = async (req, res) => {
  try {
    const partner = await partnerForPanelUser(req.panel.user_id);
    if (partner == null) {
      // A panel-created rider has no delivery-app account, so no shifts exist.
      // Not an error — the screen shows an explanation instead.
      return res.json({ linked: false, overview: null });
    }
    res.json({ linked: true, overview: await shiftOverview(partner.dp_id) });
  } catch (err) {
    console.log("MFB-error-logs ~ panel my shifts ~ err:", err);
    res.status(500).json({ message: "Failed to load your shifts" });
  }
};

// GET /admin/delivery/shifts/:id — one shift with the sessions worked inside it.
exports.detail = async (req, res) => {
  try {
    const shift = await DeliveryShift.findByPk(req.params.id);
    if (shift == null) return res.status(404).json({ message: "Shift not found" });
    res.json(await shiftDetail(shift));
  } catch (err) {
    console.log("MFB-error-logs ~ panel shift detail ~ err:", err);
    res.status(500).json({ message: "Failed to load shift" });
  }
};

// GET /admin/delivery/sessions?dp_id=&date= — one rider's online sessions.
exports.sessions = async (req, res) => {
  try {
    const dpId = Number(req.query.dp_id);
    if (!dpId) return res.status(400).json({ message: "dp_id is required" });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const sessions = await sessionsForDay(dpId, date);
    res.json({
      date,
      // Each session with the breadcrumb trail recorded while it ran.
      sessions: await Promise.all(
        sessions.map(async (s) => ({ ...s, points: await pointsForSession(s.id) }))
      ),
      active: await activeTotals(dpId, new Date(date)),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ panel sessions ~ err:", err);
    res.status(500).json({ message: "Failed to load sessions" });
  }
};

// GET /admin/delivery/shifts?date=&status=&dp_id= — every rider's shifts.
exports.list = async (req, res) => {
  try {
    const where = {};
    if (req.query.date) where.shift_date = req.query.date;
    if (req.query.status) where.status = req.query.status;
    if (req.query.dp_id) where.dp_id = Number(req.query.dp_id);
    // Default to today onwards, so the page opens on what is current rather
    // than the whole history.
    if (!req.query.date) {
      where.shift_date = { [Op.gte]: new Date().toISOString().slice(0, 10) };
    }

    const shifts = await DeliveryShift.findAll({
      where,
      order: [
        ["shift_date", "ASC"],
        ["start_time", "ASC"],
      ],
      limit: 200,
    });

    // One lookup for the names, rather than an include per row.
    const ids = [...new Set(shifts.map((s) => s.dp_id))];
    const partners = ids.length
      ? await DeliveryPartner.findAll({
          where: { dp_id: ids },
          attributes: ["dp_id", "dp_name", "dp_phone", "dp_online"],
          raw: true,
        })
      : [];
    const byId = new Map(partners.map((p) => [p.dp_id, p]));

    res.json({
      shifts: shifts.map((s) => {
        const p = byId.get(s.dp_id);
        return {
          ...serializeShift(s),
          dp_id: s.dp_id,
          rider_name: p?.dp_name || "",
          rider_phone: p?.dp_phone || "",
          rider_online: !!p?.dp_online,
        };
      }),
      riders: await Promise.all(
        partners.map(async (p) => ({
          dp_id: p.dp_id,
          name: p.dp_name || "",
          phone: p.dp_phone || "",
          online: !!p.dp_online,
          // Measured online time, the figure the schedule is judged against.
          active: await activeTotals(p.dp_id),
        }))
      ),
    });
  } catch (err) {
    console.log("MFB-error-logs ~ panel shifts list ~ err:", err);
    res.status(500).json({ message: "Failed to load shifts" });
  }
};
