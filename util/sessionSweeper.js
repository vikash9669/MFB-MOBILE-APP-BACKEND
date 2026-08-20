// Closes online sessions that have gone quiet.
//
// A partner who loses data — or force-quits, or whose battery dies — never
// sends "go offline". Without this they stay online forever: still shown as
// available, still counted in active time, still eligible for offers. The app
// pushes a position about once a minute while online, so silence for longer
// than the grace window means they are not really there.
//
// The session is closed at its last known breadcrumb rather than at now, so the
// recorded time reflects when they were actually online, not when we noticed.
const { DeliveryPartner, DeliverySession, DeliverySessionPoint } = require("../models");

const GRACE_MIN = Number(process.env.DELIVERY_OFFLINE_GRACE_MIN || 5);
const EVERY_MS = 60000;

async function sweepOnce(now = new Date()) {
  const cutoff = new Date(now.getTime() - GRACE_MIN * 60000);
  // Session tracking may not be migrated yet; that is not a reason to log an
  // error every minute. startSessionSweeper reports it once instead.
  const open = await DeliverySession.findAll({ where: { ended_at: null } });
  const closed = [];

  for (const session of open) {
    const last = await DeliverySessionPoint.findOne({
      where: { session_id: session.session_id },
      order: [["recorded_at", "DESC"]],
    });
    // No breadcrumb yet means they went online and never reported — judge them
    // on when the session started instead.
    const lastSeen = last ? new Date(last.recorded_at) : new Date(session.started_at);
    if (lastSeen > cutoff) continue;

    const endedAt = lastSeen;
    await session.update({
      ended_at: endedAt,
      duration_min: Math.max(
        0,
        Math.round((endedAt - new Date(session.started_at)) / 60000)
      ),
      end_lat: last ? last.lat : session.end_lat,
      end_lng: last ? last.lng : session.end_lng,
    });
    await DeliveryPartner.update(
      { dp_online: false },
      { where: { dp_id: session.dp_id } }
    );
    closed.push({ dp_id: session.dp_id, session_id: session.session_id });
  }

  if (closed.length) {
    console.log(
      `MFB ~ session sweeper ~ auto-offline after ${GRACE_MIN}m silence:`,
      closed.map((c) => `dp ${c.dp_id}/session ${c.session_id}`).join(", ")
    );
  }
  return closed;
}

/** Runs the sweep on a timer. Failures are logged, never thrown — this must
 *  not be able to take the server down. */
function startSessionSweeper() {
  let warned = false;
  const tick = () =>
    sweepOnce().catch((err) => {
      if (warned) return;
      warned = true;
      console.log(
        "MFB ~ session sweeper idle: " +
          (err.original?.sqlMessage || err.message) +
          ". Run migrations/2026-08-08-session-location.sql to enable it."
      );
    });
  tick();
  const timer = setInterval(tick, EVERY_MS);
  // Do not hold the process open on shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

module.exports = { sweepOnce, startSessionSweeper, GRACE_MIN };
