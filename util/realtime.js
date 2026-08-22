// Server-Sent Events hub — the panel's live channel.
//
// WHY SSE AND NOT A WEBSOCKET
// The panel only ever receives on this channel; everything it sends already
// goes over the existing REST API. SSE is one-way by design, needs no new
// dependency (this service ships axios, express, jsonwebtoken, mysql2,
// nodemailer and sequelize — that is the whole list), and the browser's
// EventSource reconnects on its own. socket.io would add a dependency, a
// handshake and sticky-session requirements for nothing we need.
//
// WHAT THIS IS NOT
// State lives in this process's memory. On a single instance that is fine. If
// this service is ever scaled to two, an event published on instance A does
// not reach a client connected to instance B — so the panel also keeps a slow
// poll, and nothing is reachable ONLY through this channel. Treat a delivered
// event as "refresh now", never as the only copy of the news.

// Render's proxy drops a connection that has been idle for around 100 seconds,
// and a browser then reconnects — which works, but churns. A comment line every
// 25s keeps it open and costs almost nothing.
const HEARTBEAT_MS = 25000;

// One entry per open browser tab. A Set because the only operations are add,
// delete and iterate, and a client removes itself by identity.
const clients = new Set();

let heartbeat = null;

const startHeartbeat = () => {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const client of clients) write(client, ":ping\n\n");
  }, HEARTBEAT_MS);
  // Never hold the process open for a heartbeat. Without this a test that
  // subscribes once would hang node --test for the full timeout.
  if (typeof heartbeat.unref === "function") heartbeat.unref();
};

const stopHeartbeat = () => {
  if (heartbeat && clients.size === 0) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
};

// A write to a socket the peer has already dropped throws. That is a normal
// way for a client to leave — a closed laptop, a killed tab — so it removes
// the client rather than propagating.
const write = (client, chunk) => {
  try {
    client.res.write(chunk);
    return true;
  } catch {
    drop(client);
    return false;
  }
};

const drop = (client) => {
  clients.delete(client);
  stopHeartbeat();
};

/**
 * Registers an open response as a subscriber.
 *
 * `audience` is who the connection is allowed to hear — "admin" today. It is
 * matched exactly on publish, so adding a vendor or rider stream later cannot
 * accidentally deliver admin events to them.
 *
 * Returns the unsubscribe function. The caller MUST wire it to the request's
 * "close" event; without that, every closed tab leaks a client.
 */
function subscribe(res, { audience }) {
  const client = { res, audience };
  clients.add(client);
  startHeartbeat();
  return () => drop(client);
}

/**
 * Sends one event to every subscriber in `audience`. Never throws — a realtime
 * nicety must not be able to fail the action that raised it.
 *
 * Returns how many clients it reached, which is what the tests assert on and
 * what makes "did anyone actually get this?" answerable in a log.
 */
function publish(event, payload, { audience } = {}) {
  let delivered = 0;
  const frame =
    `event: ${event}\n` +
    `data: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const client of [...clients]) {
    if (audience && client.audience !== audience) continue;
    if (write(client, frame)) delivered += 1;
  }
  return delivered;
}

/** Open connections, for the health endpoint and for tests. */
const stats = () => {
  const byAudience = {};
  for (const c of clients) byAudience[c.audience] = (byAudience[c.audience] || 0) + 1;
  return { clients: clients.size, byAudience };
};

// Tests only: drops every subscriber so one test cannot see another's.
const _reset = () => {
  for (const c of [...clients]) drop(c);
};

module.exports = { subscribe, publish, stats, HEARTBEAT_MS, _reset };
