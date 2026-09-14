// Paging a list that shows every active order before any finished one.
//
// The admin Orders list is "active first": everything still in flight
// (Received → On the Way), newest first, then everything Delivered or
// Cancelled, newest first. Staff open the page to act on live orders, and those
// used to be scattered among the finished ones — the list was simply newest
// first, so an order still waiting for a rider could sit below a dozen that were
// already delivered.
//
// WHY TWO QUERIES AND NOT ONE ORDER BY
// The obvious `ORDER BY (order_status IN (5,6)), order_id DESC` cannot use an
// index — store_orders has none on order_status, and MySQL cannot walk an index
// for an expression anyway. It would read and sort the entire table (≈160k
// rows) to return 25, on a page that polls every 15 seconds for each admin who
// has it open. Newest-first by primary key reads only the rows it returns.
//
// So a page is filled from two primary-key-ordered queries — active rows, then
// finished rows — each told exactly how many rows to take and how many to skip.
// Knowing the active count up front is what makes that possible: the active
// query stops the moment it has its rows, instead of scanning on to prove there
// are no more.

/** store_orders.order_status values that end an order: Delivered, Cancelled. */
const FINISHED_STATUSES = [5, 6];

/**
 * Which slice of each half fills this page.
 *
 * Imagine all active rows laid end to end, then all finished rows after them;
 * a page is `limit` rows starting at `(page - 1) * limit`. This works out how
 * much of that window falls in each half, and where in each half it starts.
 *
 * @param {{ page: number, limit: number, activeCount: number }} args
 * @returns {{ activeOffset: number, activeTake: number, finishedOffset: number, finishedTake: number }}
 */
function activeFirstWindow({ page, limit, activeCount }) {
  const offset = (page - 1) * limit;
  const activeTake = Math.max(0, Math.min(limit, activeCount - offset));
  return {
    activeOffset: activeTake > 0 ? offset : 0,
    activeTake,
    // Past the end of the active rows, the finished half starts counting from
    // its own beginning.
    finishedOffset: Math.max(0, offset - activeCount),
    finishedTake: limit - activeTake,
  };
}

module.exports = { FINISHED_STATUSES, activeFirstWindow };
