const { DataTypes } = require("sequelize");
const sequelize = require("../util/database");

// A breadcrumb on an online session — one position sample, roughly per minute
// while the partner is online.
//
// The session row holds only where a partner started and finished. This is the
// trail between: it answers "where were they during the shift", and it is what
// the start/end points fall back to when GPS was slow at the moment of the
// toggle itself.
const DeliverySessionPoint = sequelize.define(
  "delivery_session_point",
  {
    point_id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    session_id: { type: DataTypes.INTEGER, allowNull: false },
    dp_id: { type: DataTypes.INTEGER, allowNull: false },
    recorded_at: { type: DataTypes.DATE, allowNull: false },
    lat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    lng: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
  },
  {
    tableName: "store_delivery_session_points",
    timestamps: false,
    indexes: [
      { name: "PRIMARY", unique: true, using: "BTREE", fields: [{ name: "point_id" }] },
      { name: "dsp_session_idx", using: "BTREE", fields: [{ name: "session_id" }] },
      { name: "dsp_partner_idx", using: "BTREE", fields: [{ name: "dp_id" }] },
    ],
  }
);

module.exports = DeliverySessionPoint;
