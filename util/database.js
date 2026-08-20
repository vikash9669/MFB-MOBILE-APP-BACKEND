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
    logging: false
});

module.exports = sequelize;
