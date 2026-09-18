// Receiving the rider app's location samples and folding them into presence.
//
// Both transports end here: the WebSocket (util/presence/socket.js) and the HTTP
// fallback (controllers/deliveryPresence.js). The phone deletes a sample only
// once this has acknowledged its sequence number, so everything up to the ack
// must be durably stored before the ack is sent.
//
// A sample is { seq, t, kind, lat?, lng?, acc? }:
//   seq   increasing per device — what the ack refers to
//   t     the PHONE's epoch ms when it was taken (not when it arrived)
//   kind  "fix" (online, with a location) | "online" | "offline" (the toggle)
//         | "net" (reconnected at t after losing the connection at lost_at —
//           over PRESENCE_GAP_MIN that whole outage is offline, spans.js)
const { QueryTypes } = require("sequelize");
const sequelize = require("../database");
const { foldSamples } = require("./spans");
const { presenceConfig } = require("./config");

const KINDS = new Set(["fix", "online", "offline", "net"]);

/**
 * Validates a batch and corrects it for the phone's clock.
 *
 * The phone stamps every sample with its own clock, and sends its current time
 * with the batch. If the two disagree by more than network latency could
 * explain, the phone's clock is wrong by that much and every sample in the
 * batch is shifted by the same amount. That is exact for a clock that is
 * simply set wrong, which is the common case; a clock changed mid-backlog is
 * not recoverable from here and is bounded by the backfill window.
 *
 * Returns { samples, rejected, maxSeq, skewMs }. maxSeq covers rejected
 * samples too: a sample that can never be accepted must still be acked, or the
 * phone would resend it forever.
 */
function normalizeBatch(raw, { clientNowMs, serverNowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const list = Array.isArray(raw) ? raw.slice(0, cfg.maxBatch) : [];

  const clientNow = Number(clientNowMs);
  let skewMs = 0;
  if (Number.isFinite(clientNow) && clientNow > 0) {
    const diff = serverNowMs - clientNow;
    if (Math.abs(diff) > cfg.skewToleranceMs) skewMs = diff;
  }

  const samples = [];
  let rejected = 0;
  let maxSeq = null;
  for (const item of list) {
    const seq = Number(item?.seq);
    if (Number.isInteger(seq) && seq >= 0) maxSeq = maxSeq == null ? seq : Math.max(maxSeq, seq);

    const kind = String(item?.kind ?? "fix");
    const t = Number(item?.t) + skewMs;
    const lat = item?.lat == null ? null : Number(item.lat);
    const lng = item?.lng == null ? null : Number(item.lng);
    // When the phone lost its connection, on the same (corrected) clock. An
    // outage that began before the backfill window is cut from its start —
    // there is no older online time left to cut anyway.
    const lostAt =
      kind === "net" ? Math.max(Number(item?.lost_at) + skewMs, serverNowMs - cfg.backfillMs) : null;

    const valid =
      Number.isInteger(seq) &&
      seq >= 0 &&
      KINDS.has(kind) &&
      Number.isFinite(t) &&
      t <= serverNowMs + cfg.futureMs &&
      t >= serverNowMs - cfg.backfillMs &&
      (kind !== "net" || (Number.isFinite(lostAt) && lostAt < t)) &&
      (kind !== "fix" ||
        (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)));

    if (!valid) {
      rejected += 1;
      continue;
    }
    samples.push(
      kind === "net"
        ? { seq, t: Math.round(t), kind, lost_at: Math.round(lostAt) }
        : { seq, t: Math.round(t), kind, lat, lng }
    );
  }
  return { samples, rejected, maxSeq, skewMs };
}

const toSpan = (row) => ({
  span_id: Number(row.span_id),
  start_ms: Number(row.start_ms),
  end_ms: Number(row.end_ms),
  samples: Number(row.samples),
  end_reason: row.end_reason ?? null,
  start_lat: row.start_lat == null ? null : Number(row.start_lat),
  start_lng: row.start_lng == null ? null : Number(row.start_lng),
  end_lat: row.end_lat == null ? null : Number(row.end_lat),
  end_lng: row.end_lng == null ? null : Number(row.end_lng),
});

const sameSpan = (a, b) =>
  a.start_ms === b.start_ms &&
  a.end_ms === b.end_ms &&
  a.samples === b.samples &&
  a.end_reason === b.end_reason;

// One ingest per rider at a time within this process. The database lock below
// is what makes it correct across processes; this just keeps a WebSocket and a
// retried HTTP upload from the same phone queueing on that lock.
const chains = new Map();
function serialized(dpId, fn) {
  const prev = chains.get(dpId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(dpId, tail);
  tail.then(() => {
    if (chains.get(dpId) === tail) chains.delete(dpId);
  });
  return run;
}

/**
 * Stores a batch. Returns { ackSeq, accepted, rejected, latestFix, skewMs }.
 *
 * Throws on a database failure — the caller must NOT ack in that case, so the
 * phone keeps the samples and sends them again.
 */
async function ingestSamples(dpId, rawSamples, { clientNowMs, serverNowMs = Date.now() } = {}) {
  const cfg = presenceConfig();
  const { samples, rejected, maxSeq, skewMs } = normalizeBatch(rawSamples, { clientNowMs, serverNowMs });
  if (samples.length === 0) {
    return { ackSeq: maxSeq, accepted: 0, rejected, latestFix: null, skewMs };
  }

  // An outage reaches back to when the connection dropped, and every span it
  // overlaps has to be loaded to be cut.
  const minT = samples.reduce((m, s) => Math.min(m, s.t, s.lost_at ?? Infinity), Infinity);
  const maxT = samples.reduce((m, s) => Math.max(m, s.t), -Infinity);

  await serialized(dpId, () =>
    sequelize.transaction(async (transaction) => {
      // The rider's own row is the lock. Locking a range of spans is not
      // enough: when no span exists yet there is no row to lock, and two
      // concurrent uploads would each create one.
      await sequelize.query("SELECT `user_id` FROM `store_users` WHERE `user_id` = :dpId FOR UPDATE", {
        replacements: { dpId },
        type: QueryTypes.SELECT,
        transaction,
      });

      // Every span a sample could touch lies within the gap of the batch.
      const rows = await sequelize.query(
        `SELECT * FROM \`store_rider_presence_spans\`
          WHERE \`dp_id\` = :dpId AND \`end_ms\` >= :from AND \`start_ms\` <= :to
          ORDER BY \`start_ms\``,
        {
          replacements: { dpId, from: minT - cfg.gapMs, to: maxT + cfg.gapMs },
          type: QueryTypes.SELECT,
          transaction,
        }
      );
      const before = rows.map(toSpan);
      const { spans, removed } = foldSamples(before, samples, cfg.gapMs);
      const beforeById = new Map(before.map((s) => [s.span_id, s]));

      if (removed.length) {
        await sequelize.query(
          "DELETE FROM `store_rider_presence_spans` WHERE `dp_id` = :dpId AND `span_id` IN (:ids)",
          { replacements: { dpId, ids: removed }, type: QueryTypes.DELETE, transaction }
        );
      }
      for (const span of spans) {
        const values = {
          dpId,
          start: span.start_ms,
          end: span.end_ms,
          samples: span.samples,
          reason: span.end_reason,
          slat: span.start_lat,
          slng: span.start_lng,
          elat: span.end_lat,
          elng: span.end_lng,
          now: serverNowMs,
        };
        if (span.span_id == null) {
          await sequelize.query(
            `INSERT INTO \`store_rider_presence_spans\`
               (\`dp_id\`, \`start_ms\`, \`end_ms\`, \`samples\`, \`end_reason\`,
                \`start_lat\`, \`start_lng\`, \`end_lat\`, \`end_lng\`, \`updated_ms\`)
             VALUES (:dpId, :start, :end, :samples, :reason, :slat, :slng, :elat, :elng, :now)`,
            { replacements: values, type: QueryTypes.INSERT, transaction }
          );
        } else if (!sameSpan(span, beforeById.get(span.span_id))) {
          await sequelize.query(
            `UPDATE \`store_rider_presence_spans\`
                SET \`start_ms\` = :start, \`end_ms\` = :end, \`samples\` = :samples,
                    \`end_reason\` = :reason, \`start_lat\` = :slat, \`start_lng\` = :slng,
                    \`end_lat\` = :elat, \`end_lng\` = :elng, \`updated_ms\` = :now
              WHERE \`span_id\` = :id`,
            { replacements: { ...values, id: span.span_id }, type: QueryTypes.UPDATE, transaction }
          );
        }
      }
    })
  );

  const fixes = samples.filter((s) => s.kind === "fix");
  const latestFix = fixes.reduce((a, s) => (a == null || s.t > a.t ? s : a), null);
  const lastEvent = samples.reduce((a, s) => (a == null || s.t > a.t ? s : a), null);

  // Everything below is about the rider's LIVE state, so it only acts on data
  // that is fresh. Stored successfully either way; failures here must never
  // cost the phone its ack.
  if (latestFix && serverNowMs - latestFix.t <= cfg.gapMs) {
    await applyLiveFix(dpId, latestFix, { wentOffline: lastEvent?.kind === "offline" }).catch((err) =>
      console.log("MFB ~ presence ~ live update ~", err.message)
    );
  }
  // Trail points attach to whichever session is open NOW, so only fresh fixes
  // belong there — a backlog from before a reconnect would land on the wrong
  // session. Online time and pay come from spans, which the backlog did reach.
  const freshFixes = fixes.filter((f) => serverNowMs - f.t <= cfg.gapMs);
  await recordTrail(dpId, freshFixes).catch((err) => console.log("MFB ~ presence ~ trail ~", err.message));

  return { ackSeq: maxSeq, accepted: samples.length, rejected, latestFix, skewMs };
}

/**
 * The rider's live position, and — if the sweeper marked them offline while
 * their phone was silent — online again.
 *
 * Re-onlining is what "reconnected within the rules" means for dispatch: the
 * phone only takes fixes while the rider has switched online, so a fresh fix
 * from a rider the server believes is offline is the server being out of date.
 * An offline tap at the end of the batch wins, though: they meant it.
 */
async function applyLiveFix(dpId, fix, { wentOffline }) {
  const { DeliveryPartner } = require("../../models");
  const { dispatchReady } = require("../dispatch/columns");

  const partner = await DeliveryPartner.findByPk(dpId, {
    attributes: ["dp_id", "dp_online", "dp_verification_status"],
  });
  if (!partner) return;

  await DeliveryPartner.update({ dp_lat: fix.lat, dp_lng: fix.lng }, { where: { dp_id: dpId } });
  // dp_location_at is what dispatch and the stale-location sweeper judge
  // freshness by. Only this path writes it: older app versions report location
  // only from order screens, and stamping those would start excluding riders
  // who are idle on the home screen.
  if (await dispatchReady()) {
    await sequelize.query(
      "UPDATE `store_users` SET `dp_location_at` = :at WHERE `user_id` = :dpId",
      { replacements: { at: new Date(fix.t), dpId }, type: QueryTypes.UPDATE }
    );
  }

  if (!partner.dp_online && !wentOffline && partner.dp_verification_status === "approved") {
    await DeliveryPartner.update({ dp_online: true }, { where: { dp_id: dpId } });
    const { startSession } = require("../deliverySessions");
    await startSession(dpId, new Date(fix.t), { lat: fix.lat, lng: fix.lng });
    console.log(`MFB ~ presence ~ dp ${dpId} back online (reconnected)`);
  }

  // The customer's "your rider is almost here", which used to hang off the
  // once-a-minute location push this replaces.
  try {
    const orderCustomerNotify = require("../orderCustomerNotify");
    orderCustomerNotify.checkNearDrop(dpId, fix.lat, fix.lng).catch(() => {});
  } catch {
    // Not every deployment has customer notifications wired.
  }
}

// The shift screens draw a trail of where the rider was. One point a minute is
// plenty for that, and twelve rows a minute per rider is not what that table
// is for.
const TRAIL_EVERY_MS = 60_000;
const lastTrail = new Map();
async function recordTrail(dpId, fixes) {
  if (fixes.length === 0) return;
  const { recordPoint } = require("../deliverySessions");
  let last = lastTrail.get(dpId) ?? 0;
  for (const f of [...fixes].sort((a, b) => a.t - b.t)) {
    if (f.t - last < TRAIL_EVERY_MS) continue;
    await recordPoint(dpId, f.lat, f.lng, new Date(f.t));
    last = f.t;
  }
  lastTrail.set(dpId, last);
}

module.exports = { normalizeBatch, ingestSamples, _chains: chains };
