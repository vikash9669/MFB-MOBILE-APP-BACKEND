// The panel's live channel: a ticket endpoint and an SSE stream.
//
// WHY A TICKET
// The panel authenticates with a bearer JWT held in localStorage. The browser's
// EventSource cannot set request headers — there is no option for it — so the
// stream cannot be authenticated the way every other endpoint here is. The
// alternatives are a cookie (this API is cross-origin and cookieless today, and
// adding one would drag in SameSite and credentialed CORS) or a token in the
// query string.
//
// A query-string token is chosen, with the two properties that makes it
// acceptable: it is minted only for an already-authenticated admin, and it
// expires in 60 seconds. A URL does leak more easily than a header — into
// proxy logs, into a Referer — so the window in which a leaked one is worth
// anything is the point. It is a separate scope from the panel token, so a
// stolen ticket cannot be replayed against the REST API.
const jwt = require("jsonwebtoken");

const { subscribe, stats } = require("../../util/realtime");
const { isAdminRole } = require("../../middlewares/verifyAdmin");

const TICKET_TTL_SECONDS = 60;
const TICKET_SCOPE = "admin_sse";

// GET /admin/realtime/ticket — behind the normal panel auth + requireAdmin.
exports.ticket = (req, res) => {
  const token = jwt.sign(
    {
      scope: TICKET_SCOPE,
      user_id: req.panel.user_id,
      role: Number(req.panel.role),
    },
    process.env.JWT_SECRET_KEY,
    { expiresIn: TICKET_TTL_SECONDS }
  );
  res.json({ ticket: token, expires_in: TICKET_TTL_SECONDS });
};

// GET /admin/realtime/stream?ticket=… — the long-lived connection.
//
// Mounted OUTSIDE the bearer-auth chain, because EventSource cannot satisfy it.
// Everything the header guard would have done is done here by hand.
exports.stream = (req, res) => {
  const ticket = req.query.ticket;
  if (!ticket) {
    return res.status(401).json({ message: "Missing ticket" });
  }

  let payload;
  try {
    payload = jwt.verify(String(ticket), process.env.JWT_SECRET_KEY);
  } catch {
    return res.status(401).json({ message: "Ticket expired" });
  }
  // Scope, not just signature. A valid panel token must not double as a stream
  // ticket, or the 60-second window this design rests on is a 12-hour one.
  if (payload.scope !== TICKET_SCOPE) {
    return res.status(401).json({ message: "Invalid ticket" });
  }
  if (!isAdminRole(payload.role)) {
    return res.status(403).json({ message: "Not permitted" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    // no-transform matters as much as no-cache: a proxy that "helpfully"
    // compresses this will buffer it, and a buffered event stream is a stream
    // that delivers nothing until it closes.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx (Render's edge) buffers proxied responses by default.
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // How long the browser waits before reconnecting after a drop. The default
  // is 3s; 5s is gentler on a service that sleeps on the free tier and wakes
  // to a queue of reconnects.
  res.write("retry: 5000\n\n");
  res.write(`event: ready\ndata: ${JSON.stringify({ user_id: payload.user_id })}\n\n`);

  const unsubscribe = subscribe(res, { audience: "admin" });

  // Both, deliberately. "close" is the normal path; "aborted" fires for a
  // client that vanishes without a FIN. Missing either leaks a subscriber per
  // closed tab, and the heartbeat then writes to a dead socket forever.
  req.on("close", unsubscribe);
  req.on("aborted", unsubscribe);
};

// GET /admin/realtime/stats — how many panels are actually listening.
// Small, but the alternative to "did the event go anywhere?" is guessing.
exports.stats = (_req, res) => res.json(stats());
