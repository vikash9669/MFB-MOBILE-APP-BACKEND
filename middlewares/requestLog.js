// One line per request, written when the response finishes.
//
// The app previously logged nothing per request, which made a deployed instance
// indistinguishable from a dead one: an uptime ping every few minutes produced
// no output at all, so an empty log read as "the service is not running" rather
// than "the service is idle". It also meant a slow endpoint could only be found
// by timing it from outside.
//
// Deliberately minimal and dependency-free:
//   - the PATH only, never the query string or body — those carry phone
//     numbers, addresses and tokens, and a log is the easiest place for that to
//     leak out of;
//   - no request headers, for the same reason (Authorization lives there);
//   - health checks are quiet by default, because a 30-second liveness ping
//     otherwise buries every real request. HEALTH_LOG=1 turns them back on when
//     the question is whether the pings are arriving at all.
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;

function requestLog(req, res, next) {
  const start = process.hrtime.bigint();
  // Capture the path NOW. A mounted router rewrites req.url while it dispatches
  // (app.use("/banners", ...) leaves req.path as "/" inside it), and the finish
  // handler runs after that — reading it there logged every /banners hit as
  // "GET /". Take the query string off by hand rather than reading req.path,
  // which is derived from the same mutated req.url.
  const path = req.originalUrl.split("?")[0];
  res.on("finish", () => {
    if (path.startsWith("/health") && process.env.HEALTH_LOG !== "1") return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const mark = res.statusCode >= 500 ? "✖" : res.statusCode >= 400 ? "▲" : ms >= SLOW_MS ? "…" : " ";
    console.log(
      `MFB ~ ${mark} ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`
    );
  });
  next();
}

module.exports = { requestLog };
