// The rider app's live presence channel — a WebSocket at /delivery/presence/ws.
//
// WHY A WEBSOCKET HERE, when the admin panel uses SSE (util/realtime.js): the
// panel only listens, but the rider's phone TALKS — a location sample every 5
// seconds — and needs an answer (an ack) for each batch before it may delete
// the samples. That is two-way and frequent. An HTTP request every 5 seconds
// would pay a request's headers and radio wake-up each time; one open socket
// pays once. The HTTP endpoint (POST /delivery/presence/samples) does the same
// job for when a socket cannot be opened.
//
// PROTOCOL (JSON text frames):
//   phone → { type: "auth", token }                       first frame, within 10s
//   server → { type: "ready", dp_id, server_now, gap_min }
//   phone → { type: "samples", client_now, samples: [...] }
//   server → { type: "ack", seq, accepted, rejected }       after the batch is stored
//   server → { type: "error", message }                     not stored: resend
// Close codes: 4001 token missing/expired (refresh and reconnect), 4003 not a
// partner, 4008 auth timeout.
//
// Holds no state the database does not also have, so any number of backend
// instances can serve it without sticky sessions.
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const { ingestSamples } = require("./ingest");
const { presenceConfig } = require("./config");

const PATH = "/delivery/presence/ws";
const AUTH_TIMEOUT_MS = 10_000;
// Render's proxy drops a connection idle for ~100 s. Ping well inside that; a
// phone that has not answered the previous ping is gone and is closed.
const PING_MS = 25_000;
const MAX_FRAME_BYTES = 512 * 1024;

const stats = { connections: 0, batches: 0, samples: 0, errors: 0 };

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};

function verify(token) {
  const decoded = jwt.verify(String(token || ""), process.env.JWT_SECRET_KEY);
  if (decoded?.role !== "delivery_partner" || decoded?.dp_id == null) {
    const err = new Error("Delivery partner access only");
    err.code = 4003;
    throw err;
  }
  return decoded;
}

/** Attaches the presence socket to an http.Server. Returns the WebSocketServer. */
function attachPresenceSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const path = String(req.url || "").split("?")[0];
    if (path !== PATH) return; // not ours; leave it for anything else
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    stats.connections += 1;
    let user = null;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const authTimer = setTimeout(() => {
      if (!user) ws.close(4008, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    // One batch at a time per connection: the ack for batch N must go out
    // before batch N+1 is stored, or the phone could delete samples out of order.
    let queue = Promise.resolve();

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send(ws, { type: "error", message: "bad json" });
      }

      if (!user) {
        if (msg?.type !== "auth") return ws.close(4001, "auth required");
        try {
          user = verify(msg.token);
        } catch (err) {
          return ws.close(err.code === 4003 ? 4003 : 4001, err.code === 4003 ? "not a partner" : "token invalid");
        }
        clearTimeout(authTimer);
        return send(ws, {
          type: "ready",
          dp_id: user.dp_id,
          server_now: Date.now(),
          gap_min: presenceConfig().gapMs / 60_000,
        });
      }

      if (msg?.type !== "samples") return;

      // A token that expired while the socket stayed open. The phone refreshes
      // and reconnects; the unacked samples are still on it.
      if (user.exp && user.exp * 1000 < Date.now()) return ws.close(4001, "token expired");

      queue = queue.then(async () => {
        try {
          const result = await ingestSamples(user.dp_id, msg.samples, { clientNowMs: msg.client_now });
          stats.batches += 1;
          stats.samples += result.accepted;
          send(ws, { type: "ack", seq: result.ackSeq, accepted: result.accepted, rejected: result.rejected });
        } catch (err) {
          stats.errors += 1;
          console.log("MFB-error-logs ~ presence socket ingest ~", err.message);
          send(ws, { type: "error", message: "not stored, resend" });
        }
      });
    });

    ws.on("close", () => clearTimeout(authTimer));
    ws.on("error", () => {});
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // closed underneath us
      }
    }
  }, PING_MS);
  if (typeof pinger.unref === "function") pinger.unref();
  wss.on("close", () => clearInterval(pinger));

  return wss;
}

module.exports = { attachPresenceSocket, PATH, stats };
