// What a customer is told about their order, and when it will arrive.
//
// The system tracks an order across three fields that grew up separately:
//
//   store_orders.order_status          0..6, the vendor/admin lifecycle
//   store_delivery_orders.status       offered | accepted | picked_up | delivered
//   store_delivery_orders.dispatch_state  waiting | searching | assigned | failed
//
// None of those belong in front of a customer. They collapse into five moments
// plus two dead ends, and this file is the single place that mapping lives so
// the app and the server can never disagree about which stage an order is in.
//
// The ETA is the other half. Until now the app counted down from a hardcoded
// `order_received_time + 35 minutes` — a number nobody chose, which ignored both
// the vendor's own prep promise and where the rider actually was. Now that the
// vendor states a prep time on accept (order_prep_minutes) and dispatch records
// distance, the estimate can be built from things that are true.

const { haversineKm } = require("./geo");

// Stage ids. Strings rather than numbers: they show up in logs and API
// responses, and "picking_rider" survives a schema change that renumbering
// would silently corrupt.
const STAGE = {
  PLACED: "placed",
  PREPARING: "preparing",
  FINDING_RIDER: "finding_rider",
  ON_THE_WAY: "on_the_way",
  DELIVERED: "delivered",
  DECLINED: "declined",
  NO_RIDER: "no_rider",
};

// The happy path, in order. Used for the progress bar — the two dead ends are
// deliberately absent, because they are not steps along the way to anything.
const STAGE_SEQUENCE = [
  STAGE.PLACED,
  STAGE.PREPARING,
  STAGE.FINDING_RIDER,
  STAGE.ON_THE_WAY,
  STAGE.DELIVERED,
];

const ORDER_STATUS = {
  RECEIVED: 0,
  PROCESSED: 1,
  VENDOR: 2,
  READY_TO_SHIP: 3,
  ON_THE_WAY: 4,
  DELIVERED: 5,
  CANCELLED: 6,
};

// Average city speed for a two-wheeler, km/h. Deliberately pessimistic: an
// estimate that passes is far worse than one that beats itself.
const RIDER_KMH = Number(process.env.TRACKING_RIDER_KMH || 18);
// Handover at each end — parking, finding the counter, finding the door.
const HANDOVER_MIN = Number(process.env.TRACKING_HANDOVER_MIN || 4);
// Fallback prep time when a vendor accepted before prep minutes were captured.
const DEFAULT_PREP_MIN = Number(process.env.TRACKING_DEFAULT_PREP_MIN || 20);

const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const minutesSince = (t) => (t == null ? null : minutesBetween(t, new Date()));

/** Travel time for a distance, including nothing else. */
const travelMinutes = (km) =>
  km == null ? null : Math.max(1, Math.round((km / RIDER_KMH) * 60));

/**
 * Which of the five moments this order is in.
 *
 * Order matters: the dead ends are checked first, because a cancelled order
 * with a stale delivery row would otherwise read as "on the way".
 */
function resolveStage(order, job) {
  const status = Number(order.order_status);

  if (status === ORDER_STATUS.CANCELLED) return STAGE.DECLINED;
  if (status === ORDER_STATUS.DELIVERED || job?.status === "delivered") {
    return STAGE.DELIVERED;
  }

  // A rider holding the job outranks order_status, which lags: the vendor's
  // row still says "Ready to Ship" while the rider is already riding.
  if (job?.status === "picked_up") return STAGE.ON_THE_WAY;
  if (job?.status === "accepted") return STAGE.ON_THE_WAY;

  // Dispatch gave up. Distinct from "still looking" — it needs a human, and
  // the customer deserves to know rather than watching a spinner for ever.
  if (job?.dispatch_state === "failed") return STAGE.NO_RIDER;

  if (status >= ORDER_STATUS.READY_TO_SHIP) return STAGE.FINDING_RIDER;
  if (status >= ORDER_STATUS.PROCESSED) return STAGE.PREPARING;
  return STAGE.PLACED;
}

/**
 * Minutes until the food arrives, or null when it cannot honestly be estimated.
 *
 * Null is a real answer. "Waiting for the restaurant to accept" has no
 * meaningful ETA — the kitchen has not agreed to anything yet — and inventing
 * one is how a tracking screen loses a customer's trust on its first screen.
 */
function estimateMinutes({ stage, order, job, riderPoint }) {
  switch (stage) {
    case STAGE.PLACED:
      // Unknown by nature. The screen shows the acceptance deadline instead.
      return null;

    case STAGE.PREPARING: {
      const promised = Number(order.order_prep_minutes) || DEFAULT_PREP_MIN;
      const elapsed = minutesSince(order.order_accepted_time) ?? 0;
      const remainingPrep = Math.max(0, promised - elapsed);
      const ride = travelMinutes(job?.distance_km) ?? 15;
      return Math.round(remainingPrep + ride + HANDOVER_MIN);
    }

    case STAGE.FINDING_RIDER: {
      // Food is ready; what is left is finding someone and the ride itself.
      const ride = travelMinutes(job?.distance_km) ?? 15;
      return Math.round(ride + HANDOVER_MIN + 3);
    }

    case STAGE.ON_THE_WAY: {
      // Once the rider is moving, their real position beats any stored figure.
      const drop =
        job?.drop_lat != null && job?.drop_lng != null
          ? { lat: Number(job.drop_lat), lng: Number(job.drop_lng) }
          : null;

      if (riderPoint && drop) {
        const km = haversineKm(riderPoint, drop);
        if (km != null) {
          // Straight-line underestimates roads. 1.3 is the usual correction and
          // matches what roadDistanceKm already assumes elsewhere.
          return Math.max(1, Math.round(travelMinutes(km * 1.3) + 2));
        }
      }
      // Not yet picked up, or no fix: fall back to the job's own distance.
      const ride = travelMinutes(job?.distance_km) ?? 12;
      return job?.status === "picked_up" ? ride + 2 : ride + HANDOVER_MIN;
    }

    default:
      return null;
  }
}

/**
 * The one line of status text, written the way a person would say it.
 *
 * Kept server-side so the wording can be fixed without an app release — which
 * matters most for the two dead ends, where the right words are the difference
 * between a customer who understands and one who calls support.
 */
function headline(stage, { riderName, prepMinutes, cancelReason } = {}) {
  switch (stage) {
    case STAGE.PLACED:
      return "Waiting for the restaurant to accept";
    case STAGE.PREPARING:
      return prepMinutes
        ? `Your food is being prepared · about ${prepMinutes} min`
        : "Your food is being prepared";
    case STAGE.FINDING_RIDER:
      return "Food is ready — finding a delivery partner";
    case STAGE.ON_THE_WAY:
      return riderName ? `${riderName} is bringing your order` : "Your order is on the way";
    case STAGE.DELIVERED:
      return "Delivered — enjoy your meal";
    case STAGE.DECLINED:
      return cancelReason
        ? `Order cancelled — ${cancelReason}`
        : "The restaurant could not take this order";
    case STAGE.NO_RIDER:
      return "We couldn't find a delivery partner";
    default:
      return "Tracking your order";
  }
}

/**
 * Everything the tracking screen needs, in one object.
 *
 * `late` is reported rather than hidden. When a delivery runs past its estimate
 * the honest options are to say so or to quietly re-base the number; re-basing
 * makes the screen a liar at exactly the moment the customer is watching it
 * hardest.
 */
function buildTracking({ order, job, partner, riderUser }) {
  const stage = resolveStage(order, job);

  const riderPoint =
    partner?.dp_lat != null && partner?.dp_lng != null
      ? { lat: Number(partner.dp_lat), lng: Number(partner.dp_lng) }
      : null;

  const prepMinutes = Number(order.order_prep_minutes) || null;
  const eta = estimateMinutes({ stage, order, job, riderPoint });

  // Only meaningful once someone promised something.
  const promisedBy =
    order.order_accepted_time && prepMinutes
      ? new Date(new Date(order.order_accepted_time).getTime() + prepMinutes * 60000)
      : null;

  return {
    stage,
    stage_index: STAGE_SEQUENCE.indexOf(stage), // -1 for the dead ends
    stage_count: STAGE_SEQUENCE.length,
    headline: headline(stage, {
      riderName: riderUser?.user_name?.split(" ")[0],
      prepMinutes,
      cancelReason: order.order_cancel_reason,
    }),
    eta_minutes: eta,
    // True only when we had an estimate and blew through it.
    late:
      stage === STAGE.ON_THE_WAY &&
      promisedBy != null &&
      new Date() > new Date(promisedBy.getTime() + 10 * 60000),
    prep_minutes: prepMinutes,
    accepted_at: order.order_accepted_time || null,
    // Live position is shared ONLY while a rider is actually carrying this
    // order. Before pickup it tells the customer nothing useful, and after
    // delivery it is somebody's location for no reason.
    rider_point: stage === STAGE.ON_THE_WAY ? riderPoint : null,
    is_terminal: stage === STAGE.DELIVERED || stage === STAGE.DECLINED,
  };
}

module.exports = {
  STAGE,
  STAGE_SEQUENCE,
  ORDER_STATUS,
  resolveStage,
  estimateMinutes,
  headline,
  buildTracking,
  travelMinutes,
};
