const Sequelize = require("sequelize").Sequelize;

// TIMEZONE — read this before changing it.
//
// Every DATETIME column in this database holds IST wall-clock time, because the
// PHP panel that created them runs under
// `date_default_timezone_set('Asia/Kolkata')` (admin/administration/index.php).
// That is 156k+ legacy rows and it is not going to be rewritten.
//
// Sequelize defaults to +00:00, which means it wrote and read those same
// columns as if they were UTC — every legacy timestamp came back 5h30m wrong.
// util/orders.js compensated on the write side by storing
// `Date.now() + 5.5h`, which made new orders agree with the legacy rows but
// left them disagreeing with the server clock, so anything comparing a stored
// time to `new Date()` (countdowns, "orders since", sweepers) was off.
//
// Declaring the offset here fixes both directions at once: Sequelize converts
// JS Date -> IST on write and IST -> JS Date on read, so stored values keep
// matching the legacy convention while comparisons against the clock are
// finally correct. The manual +5.5h in util/orders.js was removed in the same
// change — with this set, it would double-shift.
//
// A fixed offset, not "Asia/Kolkata": India has no DST, so the two are
// identical here, and an offset needs no timezone tables loaded in MySQL.
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER_NAME, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    dialect: "mysql",
    timezone: process.env.DB_TIMEZONE || "+05:30",
    logging: false,
    // POOL — this is about a hosting quota, not about throughput.
    //
    // Sequelize defaults to min:0 / idle:10s, which closes every connection
    // after ten idle seconds and opens a fresh one on the next query. That is
    // ordinarily harmless. Here it is not: the Hostinger account is capped at
    // max_connections_per_hour=500, and the dispatch engine alone ticks every
    // five seconds — ~720 ticks an hour, each one arriving after the pool has
    // gone idle and so each one paying for a brand-new connection. Add five
    // more sweepers and the cap is reached well before the hour is out, at
    // which point EVERY query fails with "has exceeded the
    // 'max_connections_per_hour' resource" until the counter rolls over. That
    // has taken this backend down more than once, and it reads as a database
    // outage rather than as a quota.
    //
    // Holding one connection open costs nothing and takes the steady-state
    // reconnect rate to roughly zero.
    pool: {
      max: Number(process.env.DB_POOL_MAX || 5),
      min: Number(process.env.DB_POOL_MIN || 1),
      idle: Number(process.env.DB_POOL_IDLE_MS || 300000),
      acquire: Number(process.env.DB_POOL_ACQUIRE_MS || 60000),
      evict: Number(process.env.DB_POOL_EVICT_MS || 60000),
    },
});

module.exports = sequelize;
