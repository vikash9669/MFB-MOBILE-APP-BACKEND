// Mounted at /health, ahead of the catch-all "/" routers so neither path is
// swallowed by them.
const express = require("express");

const health = require("../controllers/health");

const router = express.Router();

// Deliberately unauthenticated: a platform health check has no credentials, and
// neither response reveals anything a caller could not learn by watching the
// service respond. No table names, no counts, no configuration values.
router.get("/", health.live);
router.get("/ready", health.ready);

module.exports = router;
