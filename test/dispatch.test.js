// Unit tests for the dispatch engine's decision logic.
//
// Uses node:test, which ships with Node — this repo has no test framework and
// adding one for four files is not a trade worth making.
//
// Everything here is pure: scoring, timing and geometry take plain objects and
// return numbers. That is deliberate and is the main reason the engine is split
// the way it is — the parts that decide are testable without a database, and
// the parts that touch the database (offers.js) contain no decisions.
//
// Run with:  node --test test/
const { test, describe } = require("node:test");
const assert = require("node:assert");

const { scoreRider, travelMinutes, directionScore } = require("../util/dispatch/scoring");
const { computeDispatchAt, remainingPrepMinutes } = require("../util/dispatch/timing");
const { config } = require("../util/dispatch/config");

// Nimbahera-ish, so the numbers look like the ones in production.
const PICKUP = { lat: 24.6203, lng: 74.6786 };

const job = { pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng };

/** A rider with sensible defaults; override only what a test is about. */
const rider = (over = {}) => ({
  dpId: 1,
  location: { lat: 24.6203, lng: 74.6786 },
  currentDrop: null,
  vehicleType: "bike",
  rating: 4.5,
  acceptancePct: 90,
  totalOffers: 50,
  activeJobs: 0,
  maxConcurrent: 1,
  minutesSinceLastOffer: 10,
  ...over,
});

describe("scoring", () => {
  test("a rider at the restaurant scores near the top", () => {
    const r = scoreRider(rider(), job, { maxRadiusKm: 5 });
    assert.ok(r.score > 0.8, `expected a high score, got ${r.score}`);
    assert.equal(r.distanceKm, 0);
  });

  test("closer beats further, all else equal", () => {
    const near = scoreRider(rider(), job, { maxRadiusKm: 5 });
    const far = scoreRider(
      rider({ location: { lat: 24.66, lng: 74.71 } }),
      job,
      { maxRadiusKm: 5 }
    );
    assert.ok(near.score > far.score, `${near.score} should beat ${far.score}`);
  });

  test("a reliable rider beats a closer flaky one", () => {
    // This is the whole point of scoring over nearest-first: someone who
    // rejects two thirds of offers costs more than the 600m they save.
    const flakyClose = scoreRider(
      rider({ acceptancePct: 30, rating: 3 }),
      job,
      { maxRadiusKm: 5 }
    );
    const solidFar = scoreRider(
      rider({ location: { lat: 24.6257, lng: 74.6786 }, acceptancePct: 98, rating: 4.9 }),
      job,
      { maxRadiusKm: 5 }
    );
    assert.ok(
      solidFar.score > flakyClose.score,
      `reliable+far ${solidFar.score} should beat flaky+near ${flakyClose.score}`
    );
  });

  test("a new rider is not buried by having no history", () => {
    const newbie = scoreRider(
      rider({ acceptancePct: 0, totalOffers: 0, rating: 0 }),
      job,
      { maxRadiusKm: 5 }
    );
    // Should land mid-table, not at zero.
    assert.ok(newbie.score > 0.5, `new rider scored ${newbie.score}, too low to ever win work`);
  });

  test("a rider at capacity scores worse than an idle one", () => {
    const busy = scoreRider(rider({ activeJobs: 1, maxConcurrent: 1 }), job, { maxRadiusKm: 5 });
    const free = scoreRider(rider(), job, { maxRadiusKm: 5 });
    assert.ok(free.score > busy.score);
    assert.equal(busy.parts.load, 0);
  });

  test("score is always 0..1 and carries its parts", () => {
    const r = scoreRider(rider({ rating: 5, acceptancePct: 100 }), job, { maxRadiusKm: 1 });
    assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
    for (const [name, value] of Object.entries(r.parts)) {
      assert.ok(value >= 0 && value <= 1, `${name} out of range: ${value}`);
    }
  });

  test("a nearer rider still scores better than a far one", () => {
    // Distance no longer gates eligibility, but it must still rank — otherwise
    // a rider across the city outranks one outside the door on a tie-break.
    const at = (lngOffset) =>
      rider({ location: { lat: PICKUP.lat, lng: PICKUP.lng + lngOffset } });
    const near = scoreRider(at(0.005), job);
    const far = scoreRider(at(0.119), job);
    assert.ok(near.parts.distance > far.parts.distance, "nearer must score higher");
    assert.ok(near.score > far.score);
  });

  test("a rider with no known position is ranked, not discarded", () => {
    // The bug this whole change exists to fix: a NULL dp_lat/dp_lng used to
    // fail a SQL BETWEEN at every radius, making the rider permanently
    // invisible. Scoring must now handle the absence without crashing and
    // without flattering them to the front.
    const unknown = scoreRider(rider({ location: null }), job);
    assert.ok(Number.isFinite(unknown.score), "must produce a real score");
    const near = scoreRider(rider({ location: { lat: PICKUP.lat, lng: PICKUP.lng + 0.005 } }), job);
    assert.ok(near.score > unknown.score, "a known-near rider should still rank higher");
  });
});

describe("direction matching", () => {
  test("heading towards the restaurant beats heading away", () => {
    const me = { lat: 24.62, lng: 74.67 };
    const towards = directionScore({ location: me, currentDrop: { lat: 24.63, lng: 74.69 } }, PICKUP);
    const away = directionScore({ location: me, currentDrop: { lat: 24.61, lng: 74.65 } }, PICKUP);
    assert.ok(towards > away, `towards ${towards} should beat away ${away}`);
  });

  test("an idle rider is neutral, not penalised", () => {
    assert.equal(directionScore({ location: PICKUP, currentDrop: null }, PICKUP), 0.5);
  });
});

describe("travel time", () => {
  test("a cycle takes longer than a bike over the same distance", () => {
    assert.ok(travelMinutes(5, "cycle") > travelMinutes(5, "bike"));
  });

  test("an unknown vehicle falls back rather than returning NaN", () => {
    const t = travelMinutes(5, "hovercraft");
    assert.ok(Number.isFinite(t) && t > 0, `got ${t}`);
  });
});

describe("immediate dispatch", () => {
  // The default. A stall's food is ready in the time it takes to bag it, and
  // the slow part is finding anyone at all — so the offer ladder starts when
  // the vendor accepts, not when an estimate says the food will be ready.

  test("a long prep promise no longer holds the job back", () => {
    // The same input that the prep-aware schedule delays by ~9 minutes.
    const plan = computeDispatchAt({
      prepMinutes: 25,
      acceptedAt: new Date(),
      expectedTravelKm: 4,
      vehicleType: "bike",
    });
    assert.equal(plan.delayMin, 0);
    assert.equal(plan.reason, "immediate on accept");
  });

  test("the prep estimate is still reported, just not obeyed", () => {
    // Callers log these figures. Returning zeros would make the dispatch log
    // claim the kitchen had nothing left to cook, which is a different and
    // false statement from "we chose not to wait".
    const plan = computeDispatchAt({
      prepMinutes: 20,
      acceptedAt: new Date(),
      expectedTravelKm: 3,
      vehicleType: "bike",
    });
    assert.ok(
      Math.abs(plan.remainingPrepMin - 20) < 1,
      `expected ~20 minutes of prep reported, got ${plan.remainingPrepMin}`
    );
    assert.ok(plan.travelMin > 0, "travel estimate should still be computed");
  });

  test("the prep-aware schedule is still reachable", () => {
    const prev = process.env.DISPATCH_IMMEDIATE;
    process.env.DISPATCH_IMMEDIATE = "false";
    try {
      const plan = computeDispatchAt({
        prepMinutes: 25,
        acceptedAt: new Date(),
        expectedTravelKm: 4,
        vehicleType: "bike",
      });
      assert.ok(plan.delayMin > 0, "turning the flag off must restore the wait");
      assert.equal(plan.reason, "prep-aware");
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_IMMEDIATE;
      else process.env.DISPATCH_IMMEDIATE = prev;
    }
  });
});

describe("fleet-wide dispatch", () => {
  // Distance was removed as an eligibility rule. The engine used to search
  // expanding rings and offer only inside the current one, which excluded two
  // groups it should never have excluded: riders with a NULL dp_lat/dp_lng
  // (invisible at every radius, because the SQL used a BETWEEN), and every
  // rider around a single-stall kitchen with no fleet inside any sane radius.
  // Observed live: a rider 300m from the pickup, a search already widened to
  // its maximum 15km, and "no eligible riders in range".

  test("no radius configuration survives", () => {
    const cfg = config();
    assert.ok(!("radii" in cfg), "the ring ladder must be gone");
    assert.ok(!("broadcastRadiusKm" in cfg), "the broadcast radius must be gone");
    assert.ok(!("minCandidates" in cfg), "widening thresholds must be gone");
  });

  test("the distance reference ranks but never excludes", () => {
    // Kept only to normalise the distance term. A rider beyond it scores 0 on
    // distance and is still offered the job.
    const cfg = config();
    assert.strictEqual(cfg.distanceReferenceKm, 8);
    const veryFar = scoreRider(
      rider({ location: { lat: PICKUP.lat, lng: PICKUP.lng + 1.5 } }),
      job,
    );
    assert.strictEqual(veryFar.parts.distance, 0, "distance term bottoms out");
    assert.ok(veryFar.score > 0, "but the rider still scores and is still offered");
  });

  test("DISPATCH_RADII_KM is no longer read", () => {
    // Someone will still have it set in an environment somewhere; it must be
    // inert rather than quietly resurrecting the old behaviour.
    const prev = process.env.DISPATCH_RADII_KM;
    process.env.DISPATCH_RADII_KM = "1,2,3";
    try {
      assert.ok(!("radii" in config()));
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_RADII_KM;
      else process.env.DISPATCH_RADII_KM = prev;
    }
  });
});

describe("dispatch timing", () => {
  // The prep-aware schedule is no longer the default — DISPATCH_IMMEDIATE is on,
  // because most kitchens here are stalls (see util/dispatch/config.js). It is
  // still supported and still the right choice for restaurants with real prep
  // windows, so these tests opt into it explicitly rather than being deleted.
  // The default's own behaviour is covered in "immediate dispatch" below.
  const prepAware = (fn) => () => {
    const prev = process.env.DISPATCH_IMMEDIATE;
    process.env.DISPATCH_IMMEDIATE = "false";
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_IMMEDIATE;
      else process.env.DISPATCH_IMMEDIATE = prev;
    }
  };

  test("the brief's worked example: 15m prep, ~7m travel → wait", prepAware(() => {
    // 15 remaining - 7 travel - 3 buffer = 5 minutes of waiting.
    const plan = computeDispatchAt({
      readyInMin: 15,
      expectedTravelKm: 2.57, // ≈7 min on a bike at 22km/h
      vehicleType: "bike",
    });
    assert.ok(plan.delayMin >= 3 && plan.delayMin <= 7, `delay was ${plan.delayMin}m`);
  }));

  test("food nearly ready dispatches immediately", () => {
    const plan = computeDispatchAt({ readyInMin: 2, expectedTravelKm: 1, vehicleType: "bike" });
    assert.equal(plan.delayMin, 0);
  });

  test("no prep estimate dispatches immediately rather than stalling", prepAware(() => {
    const plan = computeDispatchAt({});
    assert.equal(plan.delayMin, 0);
    assert.equal(plan.reason, "no prep estimate");
  }));

  test("an absurd prep estimate is capped, not obeyed", prepAware(() => {
    const plan = computeDispatchAt({ readyInMin: 600, expectedTravelKm: 1, vehicleType: "bike" });
    assert.ok(plan.delayMin <= 20, `delay ${plan.delayMin} exceeded the cap`);
    assert.equal(plan.reason, "capped at max delay");
  }));

  test("the vendor's promise beats the generic estimate, and counts down", () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const left = remainingPrepMinutes({
      prepMinutes: 25,
      acceptedAt: tenMinutesAgo,
      readyInMin: 4,
      now: new Date(),
    });
    assert.ok(Math.abs(left - 15) < 0.5, `expected ~15 minutes left, got ${left}`);
  });

  test("prep time already elapsed never goes negative", () => {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    assert.equal(remainingPrepMinutes({ prepMinutes: 20, acceptedAt: hourAgo }), 0);
  });
});

