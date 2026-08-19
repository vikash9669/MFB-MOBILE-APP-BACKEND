const test = require("node:test");
const assert = require("node:assert");

const {
  STAGE,
  STAGE_SEQUENCE,
  resolveStage,
  estimateMinutes,
  headline,
  buildTracking,
} = require("../util/orderTracking");

// The customer-facing stage machine and ETA.
//
// Three fields decide what a customer is told — order_status, the delivery
// job's status, and dispatch_state — and they disagree with each other
// routinely. These tests pin the precedence, because getting it wrong shows
// someone "on the way" for an order the restaurant cancelled.

const order = (o = {}) => ({ order_status: 0, ...o });
const minsAgo = (n) => new Date(Date.now() - n * 60000);

test("the happy path walks the five stages in order", () => {
  assert.equal(resolveStage(order({ order_status: 0 }), null), STAGE.PLACED);
  assert.equal(resolveStage(order({ order_status: 1 }), null), STAGE.PREPARING);
  assert.equal(resolveStage(order({ order_status: 2 }), null), STAGE.PREPARING);
  assert.equal(resolveStage(order({ order_status: 3 }), null), STAGE.FINDING_RIDER);
  assert.equal(
    resolveStage(order({ order_status: 3 }), { status: "picked_up" }),
    STAGE.ON_THE_WAY
  );
  assert.equal(resolveStage(order({ order_status: 5 }), null), STAGE.DELIVERED);
});

test("a cancelled order is never 'on the way', however stale the delivery row", () => {
  // The dead ends are checked first for exactly this case: an order cancelled
  // while a delivery row still says a rider has it.
  const stage = resolveStage(order({ order_status: 6 }), { status: "picked_up" });
  assert.equal(stage, STAGE.DECLINED);
});

test("a rider holding the job outranks a lagging order_status", () => {
  // order_status stays at "Ready to Ship" while the rider is already riding —
  // the vendor never updates it again.
  const stage = resolveStage(order({ order_status: 3 }), { status: "accepted" });
  assert.equal(stage, STAGE.ON_THE_WAY);
});

test("dispatch giving up is distinct from still looking", () => {
  const searching = resolveStage(order({ order_status: 3 }), {
    status: "offered",
    dispatch_state: "searching",
  });
  assert.equal(searching, STAGE.FINDING_RIDER);

  const failed = resolveStage(order({ order_status: 3 }), {
    status: "offered",
    dispatch_state: "failed",
  });
  assert.equal(failed, STAGE.NO_RIDER, "a customer must not watch a spinner for ever");
});

test("the dead ends are not steps in the progress bar", () => {
  assert.equal(STAGE_SEQUENCE.includes(STAGE.DECLINED), false);
  assert.equal(STAGE_SEQUENCE.includes(STAGE.NO_RIDER), false);
  assert.equal(STAGE_SEQUENCE.length, 5);
});

test("no ETA is promised before the restaurant has accepted", () => {
  // Inventing a number here is how the screen loses trust on its first frame:
  // the kitchen has not agreed to anything yet.
  const eta = estimateMinutes({ stage: STAGE.PLACED, order: order(), job: null });
  assert.equal(eta, null);
});

test("the ETA uses the vendor's own prep promise, not a hardcoded 35 minutes", () => {
  const withPromise = estimateMinutes({
    stage: STAGE.PREPARING,
    order: order({ order_prep_minutes: 30, order_accepted_time: minsAgo(0) }),
    job: { distance_km: 2 },
  });
  const shorterPromise = estimateMinutes({
    stage: STAGE.PREPARING,
    order: order({ order_prep_minutes: 10, order_accepted_time: minsAgo(0) }),
    job: { distance_km: 2 },
  });
  assert.ok(withPromise > shorterPromise, "a longer promise must mean a later ETA");
  assert.equal(withPromise - shorterPromise, 20);
});

test("time already spent cooking comes off the estimate", () => {
  const fresh = estimateMinutes({
    stage: STAGE.PREPARING,
    order: order({ order_prep_minutes: 30, order_accepted_time: minsAgo(0) }),
    job: { distance_km: 2 },
  });
  const halfway = estimateMinutes({
    stage: STAGE.PREPARING,
    order: order({ order_prep_minutes: 30, order_accepted_time: minsAgo(15) }),
    job: { distance_km: 2 },
  });
  assert.ok(halfway < fresh);
  assert.ok(Math.abs(fresh - halfway - 15) <= 1);
});

test("prep time never goes negative on an overdue kitchen", () => {
  // An hour into a 20-minute promise, the remaining prep is zero, not -40.
  const eta = estimateMinutes({
    stage: STAGE.PREPARING,
    order: order({ order_prep_minutes: 20, order_accepted_time: minsAgo(60) }),
    job: { distance_km: 2 },
  });
  assert.ok(eta > 0, `expected a positive ETA, got ${eta}`);
});

test("once riding, the rider's real position beats the stored distance", () => {
  const job = { status: "picked_up", distance_km: 20, drop_lat: 22.75, drop_lng: 75.83 };

  const almostThere = estimateMinutes({
    stage: STAGE.ON_THE_WAY,
    order: order(),
    job,
    riderPoint: { lat: 22.752, lng: 75.832 }, // a few hundred metres away
  });
  // The job says 20km; the rider is nearly at the door. Position must win.
  assert.ok(almostThere < 6, `expected a small ETA, got ${almostThere}`);

  const noFix = estimateMinutes({ stage: STAGE.ON_THE_WAY, order: order(), job });
  assert.ok(noFix > almostThere, "without a fix it should fall back to the job distance");
});

test("a missing prep promise falls back rather than producing NaN", () => {
  // Orders accepted before the lifecycle migration have no prep minutes.
  const eta = estimateMinutes({
    stage: STAGE.PREPARING,
    order: order({ order_prep_minutes: null, order_accepted_time: null }),
    job: { distance_km: null },
  });
  assert.ok(Number.isFinite(eta) && eta > 0, `got ${eta}`);
});

test("the rider's location is shared only while they are carrying the order", () => {
  const partner = { dp_lat: 22.75, dp_lng: 75.83 };
  const job = { drop_lat: 22.76, drop_lng: 75.84, distance_km: 2 };

  const riding = buildTracking({
    order: order({ order_status: 3 }),
    job: { ...job, status: "picked_up" },
    partner,
  });
  assert.ok(riding.rider_point, "should be visible while carrying the order");

  // Before pickup it tells the customer nothing useful; after delivery it is
  // somebody's location for no reason.
  const before = buildTracking({
    order: order({ order_status: 3 }),
    job: { ...job, status: "offered" },
    partner,
  });
  assert.equal(before.rider_point, null);

  const after = buildTracking({
    order: order({ order_status: 5 }),
    job: { ...job, status: "delivered" },
    partner,
  });
  assert.equal(after.rider_point, null);
});

test("lateness is reported, not hidden", () => {
  // Re-basing the number quietly makes the screen a liar at exactly the moment
  // the customer is watching it hardest.
  const late = buildTracking({
    order: order({
      order_status: 3,
      order_prep_minutes: 15,
      order_accepted_time: minsAgo(90),
    }),
    job: { status: "picked_up", distance_km: 2, drop_lat: 22.76, drop_lng: 75.84 },
    partner: null,
  });
  assert.equal(late.late, true);

  const onTime = buildTracking({
    order: order({
      order_status: 3,
      order_prep_minutes: 30,
      order_accepted_time: minsAgo(2),
    }),
    job: { status: "picked_up", distance_km: 2, drop_lat: 22.76, drop_lng: 75.84 },
    partner: null,
  });
  assert.equal(onTime.late, false);
});

test("headlines name the rider and never leak internal vocabulary", () => {
  const h = buildTracking({
    order: order({ order_status: 3 }),
    job: { status: "picked_up", distance_km: 2 },
    partner: null,
    riderUser: { user_name: "Ramesh Kumar" },
  }).headline;

  assert.match(h, /Ramesh/);
  assert.doesNotMatch(h, /picked_up|order_status|dispatch/i);
});

test("every stage has a headline a person would actually say", () => {
  for (const stage of Object.values(STAGE)) {
    const h = headline(stage, {});
    assert.ok(h && h.length > 8, `${stage} needs real copy, got "${h}"`);
    assert.doesNotMatch(h, /undefined|null|NaN/);
  }
});

test("a declined order surfaces the reason when there is one", () => {
  const t = buildTracking({
    order: order({ order_status: 6, order_cancel_reason: "kitchen closed" }),
    job: null,
    partner: null,
  });
  assert.equal(t.stage, STAGE.DECLINED);
  assert.match(t.headline, /kitchen closed/);
  assert.equal(t.is_terminal, true);
});

test("stage_index drives the progress bar and is -1 for dead ends", () => {
  const preparing = buildTracking({ order: order({ order_status: 1 }), job: null });
  assert.equal(preparing.stage_index, 1);
  assert.equal(preparing.stage_count, 5);

  const noRider = buildTracking({
    order: order({ order_status: 3 }),
    job: { status: "offered", dispatch_state: "failed" },
  });
  assert.equal(noRider.stage_index, -1);
});
