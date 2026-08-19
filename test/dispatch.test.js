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
const { boundingBox } = require("../util/dispatch/riderSearch");
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

  test("distance normalises against the search radius", () => {
    // 1km out is poor within a 1km search and good within a 10km one.
    const rNear = rider({ location: { lat: 24.6293, lng: 74.6786 } });
    const tight = scoreRider(rNear, job, { maxRadiusKm: 1 });
    const wide = scoreRider(rNear, job, { maxRadiusKm: 10 });
    assert.ok(wide.parts.distance > tight.parts.distance);
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

describe("search radius", () => {
  test("the ladder reaches 15km", () => {
    // A stall is not in a dense delivery market: past a couple of streets there
    // may be no rider at all, and stopping at 10km abandoned those jobs.
    const prev = process.env.DISPATCH_RADII_KM;
    delete process.env.DISPATCH_RADII_KM;
    try {
      assert.deepEqual(config().radii, [1, 2, 3, 5, 10, 15]);
    } finally {
      if (prev !== undefined) process.env.DISPATCH_RADII_KM = prev;
    }
  });

  test("the near rings are unchanged, so a close rider still wins first", () => {
    const prev = process.env.DISPATCH_RADII_KM;
    delete process.env.DISPATCH_RADII_KM;
    try {
      const r = config().radii;
      assert.deepEqual(r.slice(0, 4), [1, 2, 3, 5]);
      assert.ok(r[r.length - 1] === 15, "15km must be the last resort, not the first");
    } finally {
      if (prev !== undefined) process.env.DISPATCH_RADII_KM = prev;
    }
  });

  test("a rider found at the widest ring scores worse than a near one", () => {
    // Distance is normalised against the radius actually searched, so widening
    // must not make a far rider look good. This is what stops 15km becoming a
    // way to hand long jobs to whoever happens to be furthest away.
    // ~1 degree of longitude here is about 101km, so these are roughly 2km and
    // 12km from PICKUP. Everything except position is held equal.
    const at = (lngOffset) =>
      rider({ location: { lat: PICKUP.lat, lng: PICKUP.lng + lngOffset } });
    const near = scoreRider(at(0.02), job, { maxRadiusKm: 15 });
    const far = scoreRider(at(0.119), job, { maxRadiusKm: 15 });
    assert.ok(near.score > far.score, `near ${near.score} should beat far ${far.score}`);
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

describe("search geometry", () => {
  test("the box contains the circle", () => {
    const box = boundingBox(PICKUP, 5);
    assert.ok(box.maxLat > PICKUP.lat && box.minLat < PICKUP.lat);
    assert.ok(box.maxLng > PICKUP.lng && box.minLng < PICKUP.lng);
    // ~5km is ~0.045 degrees of latitude.
    assert.ok(Math.abs(box.maxLat - PICKUP.lat - 0.045) < 0.005);
  });

  test("longitude spans wider than latitude away from the equator", () => {
    const box = boundingBox(PICKUP, 5);
    assert.ok(box.maxLng - box.minLng > box.maxLat - box.minLat);
  });
});
