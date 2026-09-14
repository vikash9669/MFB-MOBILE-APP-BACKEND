const test = require("node:test");
const assert = require("node:assert");

const { activeFirstWindow, FINISHED_STATUSES } = require("../util/activeFirstPage");

// The admin Orders list pages through active orders first, then finished ones,
// filling each page from two queries. The arithmetic below decides which rows
// each query returns. Getting it wrong would not error — it would silently show
// a row twice across two pages, or skip one, which on a dispatch screen means an
// order nobody sees.

/**
 * Pages through a fake list with the window function and returns every row in
 * the order it was shown, so the tests can check nothing was lost or repeated.
 */
function walk({ active, finished, limit }) {
  const shown = [];
  const pages = Math.max(1, Math.ceil((active + finished) / limit));
  for (let page = 1; page <= pages; page++) {
    const w = activeFirstWindow({ page, limit, activeCount: active });
    for (let i = 0; i < w.activeTake && w.activeOffset + i < active; i++) shown.push(`a${w.activeOffset + i}`);
    for (let i = 0; i < w.finishedTake && w.finishedOffset + i < finished; i++) shown.push(`f${w.finishedOffset + i}`);
  }
  return shown;
}

const expected = (active, finished) => [
  ...Array.from({ length: active }, (_, i) => `a${i}`),
  ...Array.from({ length: finished }, (_, i) => `f${i}`),
];

test("finished statuses are Delivered (5) and Cancelled (6)", () => {
  assert.deepStrictEqual(FINISHED_STATUSES, [5, 6]);
});

test("a page entirely inside the active rows takes nothing finished", () => {
  assert.deepStrictEqual(activeFirstWindow({ page: 1, limit: 25, activeCount: 30 }), {
    activeOffset: 0,
    activeTake: 25,
    finishedOffset: 0,
    finishedTake: 0,
  });
});

test("the page where active rows run out is topped up from the start of the finished rows", () => {
  assert.deepStrictEqual(activeFirstWindow({ page: 2, limit: 25, activeCount: 30 }), {
    activeOffset: 25,
    activeTake: 5,
    finishedOffset: 0,
    finishedTake: 20,
  });
});

test("the next page continues the finished rows exactly where the last one stopped", () => {
  assert.deepStrictEqual(activeFirstWindow({ page: 3, limit: 25, activeCount: 30 }), {
    activeOffset: 0,
    activeTake: 0,
    finishedOffset: 20,
    finishedTake: 25,
  });
});

test("with no active orders the list is simply the finished ones", () => {
  assert.deepStrictEqual(activeFirstWindow({ page: 1, limit: 25, activeCount: 0 }), {
    activeOffset: 0,
    activeTake: 0,
    finishedOffset: 0,
    finishedTake: 25,
  });
});

test("paging through the whole list shows every row once, active first, for many shapes", () => {
  for (const [active, finished, limit] of [
    [0, 0, 25],
    [3, 0, 25],
    [0, 7, 3],
    [25, 25, 25],
    [26, 1, 25],
    [5, 61, 25],
    [61, 5, 25],
    [7, 11, 1],
    [100, 3, 7],
  ]) {
    assert.deepStrictEqual(
      walk({ active, finished, limit }),
      expected(active, finished),
      `active=${active} finished=${finished} limit=${limit}`,
    );
  }
});
