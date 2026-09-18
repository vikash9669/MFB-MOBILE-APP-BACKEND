// Folding location samples into presence spans — the pure half of online time.
//
// A rider is online while their phone keeps producing location fixes. The
// phone samples every 5 seconds, and a gap of up to GAP between two fixes still
// counts as online (a tunnel, a dropped network, the app restarted). A longer
// gap is offline, from the last fix to the next. See RIDER_ONLINE_PAY.md.
//
// NETWORK LOSS HAS THE SAME LIMIT. The phone keeps sampling without internet
// and uploads the backlog later, so those fixes arrive and would otherwise
// count. The agreed rule is that more than GAP without a connection to the
// server is offline, fixes or not. So on reconnecting the phone reports when it
// lost the connection, and an outage longer than GAP becomes a BLACKOUT: a
// stored window in which online time is cut and any fix is ignored.
//
// The server does not keep the raw samples. It keeps SPANS: [start, end] runs of
// fixes no more than GAP apart. Everything here works on plain objects and
// numbers (epoch milliseconds) so it can be tested without a database, and so
// the rules live in one place.
//
// ORDER-INDEPENDENT ON PURPOSE. A phone that was offline uploads its backlog
// later, possibly after newer samples from a reconnect have already landed.
// Folding a fix never depends on which samples arrived first, only on their
// times, so the same set of samples always produces the same spans.

const MINUTE_MS = 60_000;

/** end_reason of a blackout row: an internet outage longer than the gap. */
const BLACKOUT = "blackout";
const isBlackout = (s) => s.end_reason === BLACKOUT;
/** Strictly inside a blackout — its edges belong to the online time around it. */
const inBlackout = (spans, t) => spans.some((s) => isBlackout(s) && t > s.start_ms && t < s.end_ms);

/**
 * @typedef {object} Span
 * @property {number|null} [span_id]  database id; null for a span not yet stored
 * @property {number} start_ms
 * @property {number} end_ms
 * @property {number} samples          fixes folded in
 * @property {"offline"|"blackout"|null} end_reason
 *     "offline"  the rider went offline at end_ms: nothing may extend it forward
 *     "blackout" not presence at all — a no-internet window longer than the gap
 * @property {number|null} [start_lat]
 * @property {number|null} [start_lng]
 * @property {number|null} [end_lat]
 * @property {number|null} [end_lng]
 */

const clone = (s) => ({ ...s });

/**
 * Folds one location fix into a set of spans.
 *
 * Returns { spans, removed }: the new span list (sorted) and the ids of stored
 * spans that were absorbed into another and must be deleted.
 *
 * @param {Span[]} spans
 * @param {{ t: number, lat?: number, lng?: number }} fix
 * @param {number} gapMs
 */
function foldFix(spans, fix, gapMs) {
  const { t } = fix;
  // Taken during an outage longer than the gap: offline by rule, however many
  // fixes the phone recorded.
  if (inBlackout(spans, t)) return { spans, removed: [] };
  // A span can take this fix if the fix lies within the gap of it — but never
  // past an explicit go-offline. Backwards is fine: an earlier fix just starts
  // the span sooner.
  const joins = spans.filter(
    (s) =>
      !isBlackout(s) &&
      t >= s.start_ms - gapMs &&
      t <= s.end_ms + gapMs &&
      !(s.end_reason === "offline" && t > s.end_ms)
  );

  if (joins.length === 0) {
    const created = {
      span_id: null,
      start_ms: t,
      end_ms: t,
      samples: 1,
      end_reason: null,
      start_lat: fix.lat ?? null,
      start_lng: fix.lng ?? null,
      end_lat: fix.lat ?? null,
      end_lng: fix.lng ?? null,
    };
    return { spans: sortSpans([...spans, created]), removed: [] };
  }

  // Merge every joinable span with the fix. When the fix bridges two spans,
  // both collapse into the earliest-stored one so its id survives.
  const ordered = [...joins].sort((a, b) => a.start_ms - b.start_ms);
  const keep = clone(
    ordered.find((s) => s.span_id != null) ?? ordered[0]
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  keep.start_ms = Math.min(first.start_ms, t);
  keep.end_ms = Math.max(last.end_ms, t);
  keep.samples = ordered.reduce((n, s) => n + s.samples, 0) + 1;

  if (t < first.start_ms) {
    keep.start_lat = fix.lat ?? first.start_lat ?? null;
    keep.start_lng = fix.lng ?? first.start_lng ?? null;
  } else {
    keep.start_lat = first.start_lat ?? null;
    keep.start_lng = first.start_lng ?? null;
  }
  if (t > last.end_ms) {
    keep.end_lat = fix.lat ?? last.end_lat ?? null;
    keep.end_lng = fix.lng ?? last.end_lng ?? null;
    keep.end_reason = null;
  } else {
    keep.end_lat = last.end_lat ?? null;
    keep.end_lng = last.end_lng ?? null;
    keep.end_reason = last.end_reason ?? null;
  }

  // Every other stored span in the merge is now part of `keep`.
  const absorbed = new Set(ordered);
  const removed = ordered
    .filter((s) => s.span_id != null && s.span_id !== keep.span_id)
    .map((s) => s.span_id);

  const rest = spans.filter((s) => !absorbed.has(s));
  return { spans: sortSpans([...rest, keep]), removed };
}

/**
 * Folds an explicit go-offline at time t.
 *
 * Closes the span that was running at t, so the next fix — however soon —
 * starts a new span instead of papering over the time the rider chose to be
 * offline. Time between the last fix and the tap (up to the gap) counts, the
 * same as any other gap.
 *
 * A tap that falls inside a span (fixes exist after it) is ignored: the phone
 * kept sending after the tap, which means the rider went back online.
 *
 * A tap with no span to close yet is kept as a zero-length MARKER — a span of
 * no time and no samples, ended "offline". The fixes that led up to it may
 * simply not have arrived yet (a retried upload overtaking an earlier one), and
 * when they do, foldFix joins them onto the marker and the span still ends at
 * the tap. Without the marker the tap would be lost and the answer would depend
 * on arrival order. A marker counts no online time.
 *
 * @param {Span[]} spans
 * @param {number} t
 * @param {number} gapMs
 */
function foldOffline(spans, t, gapMs) {
  const target = spans.find(
    (s) =>
      s.end_reason == null && t >= s.end_ms && t <= s.end_ms + gapMs && t >= s.start_ms
  );
  if (target) {
    const updated = { ...target, end_ms: t, end_reason: "offline" };
    return { spans: sortSpans(spans.map((s) => (s === target ? updated : s))), removed: [] };
  }
  const inside = spans.some((s) => !isBlackout(s) && t >= s.start_ms && t < s.end_ms);
  const already = spans.some((s) => s.end_reason === "offline" && s.end_ms === t);
  if (inside || already) return { spans, removed: [] };
  const marker = {
    span_id: null,
    start_ms: t,
    end_ms: t,
    samples: 0,
    end_reason: "offline",
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
  };
  return { spans: sortSpans([...spans, marker]), removed: [] };
}

/**
 * Folds an internet outage: the phone lost its connection at `fromMs` and got
 * it back at `toMs`. Only called for outages longer than the gap.
 *
 * Online time inside the window is cut out of every span it overlaps — the
 * part before the outage keeps the span's id, the part after becomes a new
 * span — and a blackout row is stored so a fix from inside the window that
 * arrives later (a retried upload) is ignored rather than filling it back in.
 * Folding the same outage twice changes nothing.
 */
function foldBlackout(spans, fromMs, toMs) {
  if (spans.some((s) => isBlackout(s) && s.start_ms === fromMs && s.end_ms === toMs)) {
    return { spans, removed: [] };
  }
  const out = [];
  const removed = [];
  for (const s of spans) {
    if (isBlackout(s) || s.end_ms <= fromMs || s.start_ms >= toMs) {
      out.push(s);
      continue;
    }
    const duration = Math.max(1, s.end_ms - s.start_ms);
    const leftMs = Math.max(0, fromMs - s.start_ms);
    const rightMs = Math.max(0, s.end_ms - toMs);
    // Edges are inclusive: a fix taken exactly as the connection dropped, or
    // exactly as it came back, is online either way — and must stay so
    // whichever arrived first, the fix or the report of the outage.
    const left =
      s.start_ms <= fromMs
        ? { ...s, end_ms: fromMs, end_reason: null, end_lat: null, end_lng: null, samples: Math.max(1, Math.round((s.samples * leftMs) / duration)) }
        : null;
    const right =
      s.end_ms >= toMs
        ? {
            ...s,
            span_id: left ? null : s.span_id,
            start_ms: toMs,
            start_lat: null,
            start_lng: null,
            samples: Math.max(1, Math.round((s.samples * rightMs) / duration)),
          }
        : null;
    if (left) out.push(left);
    if (right) out.push(right);
    if (!left && !right && s.span_id != null) removed.push(s.span_id);
  }
  out.push({
    span_id: null,
    start_ms: fromMs,
    end_ms: toMs,
    samples: 0,
    end_reason: BLACKOUT,
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
  });
  return { spans: sortSpans(out), removed };
}

/**
 * Folds a batch of samples, in time order, into spans.
 *
 * Samples: { t, kind: "fix"|"offline"|"online"|"net", lat?, lng?, lost_at? }.
 * "online" carries no presence by itself — a rider who taps online with
 * location off is not online. "net" is the phone reconnecting at t after losing
 * its connection at lost_at; an outage up to the gap changes nothing, a longer
 * one becomes a blackout.
 *
 * Returns the final spans and every stored span id to delete.
 */
function foldSamples(spans, samples, gapMs) {
  let current = sortSpans(spans.map(clone));
  const removed = new Set();
  const byTime = [...samples].sort((a, b) => a.t - b.t);
  for (const sample of byTime) {
    let result;
    if (sample.kind === "offline") {
      result = foldOffline(current, sample.t, gapMs);
    } else if (sample.kind === "net") {
      if (!(sample.lost_at < sample.t) || sample.t - sample.lost_at <= gapMs) continue;
      result = foldBlackout(current, sample.lost_at, sample.t);
    } else if (sample.kind === "fix") {
      result = foldFix(current, sample, gapMs);
    } else {
      continue;
    }
    current = result.spans;
    for (const id of result.removed) removed.add(id);
  }
  return { spans: current, removed: [...removed] };
}

const sortSpans = (spans) => [...spans].sort((a, b) => a.start_ms - b.start_ms);

/** Milliseconds of [s.start_ms, s.end_ms] inside [fromMs, toMs). */
const overlapMs = (s, fromMs, toMs) =>
  Math.max(0, Math.min(s.end_ms, toMs) - Math.max(s.start_ms, fromMs));

/** Total online milliseconds inside a window. Blackouts are not presence. */
const onlineMsIn = (spans, fromMs, toMs) =>
  spans.reduce((total, s) => (isBlackout(s) ? total : total + overlapMs(s, fromMs, toMs)), 0);

/** Whole online minutes inside a window — the unit pay is computed in. */
const onlineMinutesIn = (spans, fromMs, toMs) =>
  Math.floor(onlineMsIn(spans, fromMs, toMs) / MINUTE_MS);

module.exports = {
  MINUTE_MS,
  BLACKOUT,
  foldFix,
  foldOffline,
  foldBlackout,
  foldSamples,
  overlapMs,
  onlineMsIn,
  onlineMinutesIn,
};
