const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// One online→offline stretch for a delivery partner.
//
// dp_online on the partner row is a single boolean: it says whether they are
// online *now* and keeps no history, so active time could never be measured.
// A row is opened when a partner goes online and closed when they go offline;
// the closed rows are what "hours online" is summed from, per shift, per day,
// per week and per month.
//
// ended_at NULL means the session is still running. duration_min is written on
// close so the aggregates are a plain SUM rather than per-row arithmetic.
const DeliverySession = sequelize.define(
  "delivery_session",
  {
    session_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    // The shift this fell inside, when one covers it. Null is normal: a partner
    // may go online without having declared a shift.
    shift_id: { type: DataTypes.INTEGER, allowNull: true },
    // Calendar day of started_at, denormalised so day/week/month grouping does
    // not need a function on the column (which would defeat the index).
    session_date: { type: DataTypes.DATEONLY, allowNull: false },
    started_at: { type: DataTypes.DATE, allowNull: false },
    ended_at: { type: DataTypes.DATE, allowNull: true },
    duration_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Where the device was when the partner went online and offline. Nullable
    // throughout: location permission can be denied, GPS can time out, and a
    // session must still be recorded when it is — the times are the point, the
    // coordinates are supporting evidence.
    start_lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    start_lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    end_lat: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    end_lng: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
  },
  {
    tableName: "store_delivery_sessions",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "session_id" }] },
      { name: "dsess_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
      { name: "dsess_date_idx", using: "BTREE", fields: [{ name: "session_date" }] },
    ],
  }
);

module.exports = DeliverySession;
